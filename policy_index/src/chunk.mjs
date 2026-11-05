// A Laurier page's HTML -> citable section chunks for the vector index.
//
// Parsing is the assistant's own (worker/src/html.js), so a chunk's section path and text are what
// the live Worker would cite. On top of it, for the index:
//   - tables with column headers (12.2's penalty grids) become "Row – Column: cell" lines, so the
//     first-offence column stays attached to its penalties;
//   - numbered headings nest by their number ("4.00 Policy > 5.00 Roles" -> "5.00 Roles");
//   - long sections split into balanced parts, preferring to break before a numbered clause, and
//     each part records the clauses it holds ("4.02.04–4.02.09") and a link to its first line;
//   - the disclaimer every policy page repeats is dropped, so it doesn't make all pages look alike.
// The text that gets embedded keeps the PDF chunks' style: "<document title> | <section path>\n<text>".
import { createHash } from "node:crypto";
import { decodeEntities, htmlToSections, pageTitle } from "../../worker/src/html.js";

export const CHUNKER_VERSION = 1;
export const MAX_CHARS = 1500; // same budget as html.js; ~350 tokens, well under bge-small's 512
const MIN_TAIL = 250; // a last part shorter than this joins the one before it

const BOILERPLATE = [/^Print \| PDF$/i, /^This online version is for convenience/i];
const CLAUSE = /^(?:•\s*)?(\d{1,2}\.\d{2}(?:\.\d{2})*)\b/;

export const sha = (s, n = 16) => createHash("sha256").update(s).digest("hex").slice(0, n);
const strip = (s) => decodeEntities(String(s).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Tables whose first row is all column headers, with three or more columns and no merged cells,
// are rewritten as one line per cell: "Minor – First Offence: Written official warning. ..."
// Two-column tables are left to html.js, which already writes them as "a – b".
export function linearizeTables(html) {
  return html.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (whole, inner) => {
    const rows = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
      [...m[1].matchAll(/<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/gi)].map((c) => ({ th: c[1].toLowerCase() === "th", span: /\b(col|row)span="?[2-9]/i.test(c[2]), html: c[3] }))
    );
    const head = rows[0];
    if (rows.length < 2 || !head || head.length < 3 || !head.every((c) => c.th)) return whole;
    if (rows.some((r) => r.length !== head.length || r.some((c) => c.span))) return whole;
    const cell = (h) => {
      const items = [...h.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => strip(m[1])).filter(Boolean);
      return items.length ? items.join(" ") : strip(h);
    };
    const caption = (inner.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i) || [])[1];
    const lines = caption ? [strip(caption)] : [];
    for (const row of rows.slice(1)) {
      const rowHead = row[0].th ? strip(row[0].html) : "";
      row.forEach((c, j) => {
        if (j === 0 && c.th) return;
        const value = cell(c.html);
        if (value) lines.push(`${[rowHead, strip(head[j].html)].filter(Boolean).join(" – ")}: ${value}`);
      });
    }
    return lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("");
  });
}

// "4.01.02 Right of Access" -> [4, 1, 2]; "4.00 Policy" -> [4]; anything else -> null.
function clauseNumber(heading) {
  const m = heading.match(/^(\d{1,2})\.(\d{2})((?:\.\d{2})*)\b/);
  if (!m) return null;
  const parts = [m[1], m[2], ...m[3].split(".").filter(Boolean)].map(Number);
  while (parts.length > 1 && parts.at(-1) === 0) parts.pop();
  return parts;
}
const isPrefix = (a, b) => a.length < b.length && a.every((x, i) => x === b[i]);

// Policy pages mix heading levels, so html.js can nest "5.00 Roles" under "4.00 Policy". A numbered
// heading only stays above another numbered heading when its number is a prefix of the other's.
export function fixNumberedPath(path) {
  const out = [];
  for (const h of path) {
    const n = clauseNumber(h);
    if (n) {
      while (out.length) {
        const last = clauseNumber(out.at(-1));
        if (!last || isPrefix(last, n)) break;
        out.pop();
      }
    }
    out.push(h);
  }
  return out;
}

// html.js already cut long sections into parts; join them back so they can be re-split here.
function mergeParts(sections) {
  const out = [];
  for (const s of sections) {
    const prev = out.at(-1);
    if (prev && prev.anchor === s.anchor && prev.path.join("\u0000") === s.path.join("\u0000")) prev.text += `\n${s.text}`;
    else out.push({ ...s });
  }
  return out;
}

function wrapLine(line, max) {
  const parts = [];
  while (line.length > max) {
    const head = line.slice(0, max);
    const cut = head.lastIndexOf(". ") > max / 3 ? head.lastIndexOf(". ") + 1 : head.lastIndexOf(" ") > 0 ? head.lastIndexOf(" ") : max;
    parts.push(line.slice(0, cut).trim());
    line = line.slice(cut).trim();
  }
  return [...parts, line];
}

// Splits text into parts of about equal size, none over `max`. Once a part is most of the way to
// its share, it ends before the next numbered clause so parts start where the policy's own
// numbering does.
export function splitText(text, max = MAX_CHARS) {
  if (text.length <= max) return [text];
  const lines = text.split("\n").flatMap((l) => wrapLine(l, max));
  const target = text.length / Math.ceil(text.length / max);
  const parts = [];
  let buf = [];
  let len = 0;
  for (const line of lines) {
    const add = line.length + (buf.length ? 1 : 0);
    if (buf.length && (len + add > max || (len >= target * 0.7 && len + add > target && CLAUSE.test(line)))) {
      parts.push(buf.join("\n"));
      buf = [];
      len = 0;
    }
    buf.push(line);
    len += line.length + (buf.length > 1 ? 1 : 0);
  }
  if (buf.length) parts.push(buf.join("\n"));
  if (parts.length > 1 && parts.at(-1).length < MIN_TAIL && parts.at(-2).length + parts.at(-1).length < max * 1.2) {
    const tail = parts.pop();
    parts[parts.length - 1] += `\n${tail}`;
  }
  return parts;
}

// The numbered clauses a chunk holds: "4.02.04–4.02.09", "5.03", or "".
export function clauseRange(text) {
  const nums = text.split("\n").map((l) => (l.match(CLAUSE) || [])[1]).filter(Boolean);
  if (!nums.length) return "";
  return nums.length === 1 || nums[0] === nums.at(-1) ? nums[0] : `${nums[0]}–${nums.at(-1)}`;
}

// Text fragment links (#:~:text=...) scroll to and highlight the words on the page. "-", "&" and ","
// are syntax inside a fragment, so they are percent-encoded.
export const textFragment = (s) => `#:~:text=${encodeURIComponent(s).replace(/-/g, "%2D")}`;
const firstWords = (s, n = 6) => s.replace(/^•\s*/, "").split(/\s+/).slice(0, n).join(" ").replace(/[\s,;:–—-]+$/, "");

// The start of a chunk's text as it appears on the page: table rows written as "a – b" by the
// parser only exist in the index, so the fragment stops before the dash.
const bodyStart = (partText) => firstWords(partText.split("\n")[0].split(" – ")[0]);
// "Policy" or "Purpose" occurs many times on a page; "4.04 Penalties for Academic Misconduct" once.
const genericHeading = (h) => h.split(/\s+/).length < 3 && !/\d/.test(h);

export function deepLink(url, sec, partText, partIndex) {
  if (partIndex === 0 && sec.anchor) return `${url}#${sec.anchor}`;
  if (partIndex === 0 && sec.heading && !genericHeading(sec.heading)) return url + textFragment(sec.heading);
  if (partIndex === 0 && !sec.heading) return url;
  return url + textFragment(bodyStart(partText));
}

function cleanText(text, title) {
  return text
    .split("\n")
    .filter((l) => l.trim() && l.trim() !== title && !BOILERPLATE.some((re) => re.test(l.trim())))
    .join("\n")
    .trim();
}

// page: { pageId, url, title? } -> [{ id, page_id, ordinal, section, heading, anchor, clauses, part,
// parts, url, text, enriched }]. Chunk ids come from the page and the section's place in it, not
// its text, so an edited section keeps its id (and is re-embedded) and a new one gets a new id.
export function chunkPage(html, page) {
  const title = page.title || pageTitle(html) || page.url;
  const chunks = [];
  const seen = new Map();
  for (const sec of mergeParts(htmlToSections(linearizeTables(html)))) {
    const text = cleanText(sec.text, title);
    if (!text) continue;
    const path = fixNumberedPath(sec.path);
    const section = path.join(" > ");
    const occurrence = (seen.get(section) || 0) + 1;
    seen.set(section, occurrence);
    const parts = splitText(text);
    parts.forEach((partText, i) => {
      chunks.push({
        id: `${sha(page.pageId, 10)}-${sha(`${section}\u0000${occurrence}\u0000${i}`, 12)}`,
        page_id: page.pageId,
        ordinal: chunks.length,
        section,
        heading: path.at(-1) || "",
        anchor: sec.anchor || "",
        clauses: clauseRange(partText),
        part: i + 1,
        parts: parts.length,
        url: deepLink(page.url, sec, partText, i),
        text: partText,
        enriched: `${title} | ${section}\n${partText}`,
      });
    });
  }
  return { title, chunks };
}

export { citationOf } from "./cite.mjs";
