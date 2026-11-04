// Turns an official Laurier web page into citable sections: [{ path: [h2, h3, ...], anchor, text }].
// Regex-based on purpose: it runs in the Worker and in Node tests, and only has to handle the
// handful of page templates used by wlu.ca, students.wlu.ca and academic-calendar.wlu.ca.

const MAX_CHARS = 1500;
const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", bull: "•", eacute: "é", egrave: "è", agrave: "à", ccedil: "ç", copy: "©", reg: "®", trade: "™", deg: "°", frac12: "½" };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const stripTags = (s) => decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

// The page's main content, without site navigation, sidebars and footers.
function contentRegion(html) {
  let m = html.match(/<div class="content">([\s\S]*?)(?:<!-- \/\.content -->|<div id="contentRHS")/i); // academic calendar
  if (m) return m[1];
  m = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (m) return m[1];
  m = html.match(/id="maincontent"[^>]*>([\s\S]*?)(?:<footer\b|<\/body>)/i); // resource pages without <main>
  if (m) return m[1];
  m = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return m ? m[1] : html;
}

export function pageTitle(html) {
  const region = contentRegion(html);
  const h1 = region.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/class="[^"]*page-title[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (h1) return stripTags(h1[1]);
  const t = html.match(/<title>([\s\S]*?)<\/title>/i);
  return t ? stripTags(t[1]).split(" | ")[0] : "";
}

export function htmlToSections(html) {
  let s = contentRegion(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|nav|form|iframe|template|button)\b[\s\S]*?<\/\1>/gi, (m, tag) =>
      tag.toLowerCase() === "button" ? stripTags(m) : " ") // accordion headings put their text in a <button>
    .replace(/\s(on\w+|style|title|alt)="[^"]*"/gi, "") // glossary tooltips carry raw HTML inside onMouseOver="..."
    .replace(/<ul[^>]*class="[^"]*breadcrumbs[^"]*"[\s\S]*?<\/ul>/gi, " ")
    .replace(/<(ul|ol)\b[^>]*>\s*<li\b[^>]*>\s*<a\b[^>]*>\s*Home\s*<\/a>[\s\S]*?<\/\1>/gi, " ") // unlabelled breadcrumbs
    .replace(/<div class="greyheading">[\s\S]*?<\/ul>/gi, " ") // calendar "Anchors"/"Months" jump lists
    .replace(/<div class="returntotop">[\s\S]*?<\/div>/gi, " ")
    .replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi, " ") // the page title is shown separately
    .replace(/\s+/g, " "); // newlines in the HTML source are not line breaks; only tags below are

  const anchorOf = (attrs, inner) =>
    (attrs.match(/\bid="([^"]+)"/i) || inner.match(/<a\b[^>]*\b(?:id|name)="([^"]+)"/i) || [])[1] || "";
  const marker = (level, attrs, inner) => {
    const text = stripTags(inner);
    return text ? `\n\u0001${level}\u0001${anchorOf(attrs, inner)}\u0001${text}\u0002\n` : " ";
  };
  s = s
    .replace(/<div class="heading">((?:(?!<h\d|<\/div)[\s\S])*)<\/div>/gi, (_, i) => marker(2, "", i)) // calendar section headings
    .replace(/<h([2-4])\b([^>]*)>([\s\S]*?)<\/h\1>/gi, (_, l, a, i) => marker(+l, a, i))
    .replace(/<th\b[^>]*>(\s*<a\b[^>]*name="[^"]*"[\s\S]*?)<\/th>/gi, (_, i) => marker(2, "", i)) // calendar month rows
    .replace(/<tr\b[^>]*>\s*<td\b[^>]*>([\s\S]*?)<\/td>\s*<td\b[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi, (_, a, b) => `\n${stripTags(a)} – ${stripTags(b)}\n`)
    .replace(/<\/td>\s*<td\b[^>]*>/gi, " – ")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<\/?(p|div|ul|ol|tr|table|thead|tbody|br|hr|section|article|header|footer|aside|h[1-6]|dd|dt|dl|blockquote|pre|figure|figcaption|summary|details)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  s = decodeEntities(s);

  const sections = [];
  const stack = []; // [{ level, text, anchor }]
  let lines = [];
  const flush = () => {
    const text = lines.join("\n").trim();
    lines = [];
    if (!text) return;
    const path = stack.map((h) => h.text);
    sections.push({ path: path.length ? path : ["Overview"], anchor: stack.at(-1)?.anchor || "", heading: stack.at(-1)?.text || "", text });
  };
  for (const raw of s.split("\n")) {
    const line = raw.replace(/[ \t ]+/g, " ").trim();
    const h = line.match(/^\u0001(\d)\u0001([^\u0001]*)\u0001([^\u0002]*)\u0002$/);
    if (h) {
      flush();
      const level = +h[1];
      while (stack.length && stack.at(-1).level >= level) stack.pop();
      stack.push({ level, anchor: h[2], text: h[3] });
    } else if (line && line !== "•" && !/^[–\s]+$/.test(line)) {
      lines.push(line);
    }
  }
  flush();
  return splitLong(datesToSentences(sections));
}

// Calendar date tables become "1 – Classes begin" rows under a "September, 2026" heading;
// rewrite them as "September 1, 2026: Classes begin" so each line stands on its own.
function datesToSentences(sections) {
  for (const sec of sections) {
    const m = sec.heading.match(new RegExp(`^(${MONTHS}),? (\\d{4})$`));
    if (!m) continue;
    sec.text = sec.text
      .replace(/^(\d{1,2}) – (.*)$/gm, `${m[1]} $1, ${m[2]}: $2`)
      .replace(/^([A-Z][a-z]{2} \d{1,2} - [A-Z][a-z]{2} \d{1,2}) – (.*)$/gm, `$1, ${m[2]}: $2`);
  }
  return sections;
}

// Breaks a line longer than MAX_CHARS at sentence ends (or spaces) so no chunk exceeds the limit.
function wrap(line) {
  const parts = [];
  while (line.length > MAX_CHARS) {
    const head = line.slice(0, MAX_CHARS);
    const sentence = head.lastIndexOf(". ");
    const space = head.lastIndexOf(" ");
    const cut = sentence > 0 ? sentence + 1 : space > 0 ? space : MAX_CHARS;
    parts.push(line.slice(0, cut).trim());
    line = line.slice(cut).trim();
  }
  return [...parts, line];
}

function splitLong(sections) {
  const out = [];
  for (const sec of sections) {
    let buf = "";
    for (const line of sec.text.split("\n").flatMap(wrap)) {
      if (buf && buf.length + line.length > MAX_CHARS) {
        out.push({ ...sec, text: buf });
        buf = "";
      }
      buf = buf ? `${buf}\n${line}` : line;
    }
    if (buf) out.push({ ...sec, text: buf });
  }
  return out;
}
