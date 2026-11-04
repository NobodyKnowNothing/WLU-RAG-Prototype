// Official Laurier pages for university-wide policy. Pages are fetched live from wlu.ca when a
// question needs them, split into sections, and kept for a few hours per Worker instance.
import { htmlToSections } from "./html.js";
import { BM25 } from "./retrieval.js";

const CAL = "Undergraduate Academic Calendar 2026/27";
const calendar = (q) => `https://academic-calendar.wlu.ca/${q}`;
const students = (p) => `https://students.wlu.ca/${p}`;

// `topics` lists the questions each page answers, in students' words; it is only used to pick
// which pages to fetch for a question, never shown or cited.
export const PAGES = [
  {
    id: "exams",
    title: "Examinations",
    publisher: CAL,
    url: calendar("section.php?cal=1&s=1174&sp=3905&ss=4668&y=93"),
    topics: "final exam examination period exam rules student ID late arrival two exams same time three exams in 24 hours deferred examination policy missed final exam aegrotat special exam religious observance tests assignments due last week of classes",
  },
  {
    id: "grades",
    title: "Grades",
    publisher: CAL,
    url: calendar("section.php?cal=1&s=1174&sp=3904&ss=4668&y=93"),
    topics: "grading scale letter grades grade points GPA percentage final grade appeal grade review reassessment grade revision incomplete DR dropped failure final exam not written attendance requirements Dean's honour roll",
  },
  {
    id: "add-drop",
    title: "Adding and Dropping Courses",
    publisher: CAL,
    url: calendar("section.php?cal=1&s=1174&sp=3893&ss=4667&y=93"),
    topics: "add a course drop a course withdraw from a course without failure deadline to drop late withdrawal",
  },
  {
    id: "petitions",
    title: "Faculty Petitions",
    publisher: CAL,
    url: calendar("section.php?cal=1&s=1174&sp=3910&ss=4669&y=93"),
    topics: "petition faculty petitions committee appeal a decision exception to regulations special consideration deadline waived documentation",
  },
  {
    id: "student-regulations",
    title: "Student Regulations",
    publisher: CAL,
    url: calendar("section.php?cal=1&s=1174&sp=3919&ss=4671&y=93"),
    topics: "attendance requirements missed class medical excuse slip doctor's note sick illness late assignment penalty course outline registration",
  },
  {
    id: "dates-fall",
    title: "Academic & Related Dates: Fall Term 2026 (12-week courses)",
    publisher: CAL,
    url: calendar("dates.php?cal=1&t=462&y=93"),
    topics: "fall term 2026 dates deadlines when do classes start begin end first day last day reading week Thanksgiving holiday no classes last day to add drop withdraw exam period exam schedule tuition due September October November December",
  },
  {
    id: "dates-winter",
    title: "Academic & Related Dates: Winter Term 2027 (12-week courses)",
    publisher: CAL,
    url: calendar("dates.php?cal=1&t=463&y=93"),
    topics: "winter term 2027 dates deadlines when do classes start begin end first day last day reading week Family Day holiday no classes last day to add drop withdraw exam period tuition due January February March April",
  },
  {
    id: "misconduct-defined",
    title: "Academic Misconduct Defined",
    publisher: "Laurier Students: Academic Integrity",
    url: students("academics/support-and-advising/academic-integrity/types-of-academic-misconduct.html"),
    topics: "what is plagiarism cheating self-plagiarism unauthorized collaboration copying impersonation buying assignments contract cheating falsifying documents unauthorized aids academic misconduct types",
  },
  {
    id: "misconduct-procedures",
    title: "Academic Misconduct Procedures",
    publisher: "Laurier Students: Academic Integrity",
    url: students("academics/support-and-advising/academic-integrity/academic-misconduct-procedures.html"),
    topics: "accused of plagiarism cheating what happens next investigation process instructor form relevant administrator penalties for academic misconduct appeal",
  },
  {
    id: "gen-ai",
    title: "Gen AI Student Resource Hub",
    publisher: "Laurier Students: Academic Integrity",
    url: students("academics/support-and-advising/academic-integrity/gen-ai-student-resource-hub.html"),
    topics: "generative AI ChatGPT Copilot AI tools allowed permitted academic integrity acknowledge cite AI use approved tool",
  },
  {
    id: "deferred-exams",
    title: "Deferred Exams",
    publisher: "Laurier Students: Exams",
    url: students("academics/exams/deferred-exams.html"),
    topics: "defer a final exam deferral petition missed exam sick illness on exam day medical grounds death in family exam conflict two exams same time three exams 24 hours deferred exam period Faculty of Science form",
  },
  {
    id: "disruptions",
    title: "Managing Unexpected Academic Disruptions",
    publisher: "Laurier Students: Dean of Students",
    url: students("support-and-wellness/student-affairs/dean-of-students/assets/resources/managing-unexpected-academic-disruptions.html"),
    topics: "sick ill missed class for a few days illness self-declaration absence less than one week one to two weeks more than two weeks injury leave of absence emergency",
  },
  {
    id: "petitions-appeals",
    title: "Academic Petitions and Appeals",
    publisher: "Laurier Students: Calendars and Petitions",
    url: students("academics/support-and-advising/calendars-and-petitions/petitions-and-appeals/index.html"),
    topics: "how to file a petition documentation medical documentation final grade appeal steps instructor chair petitions committee late withdrawal not accountable term extension to course work third attempt",
  },
  {
    id: "policy-12-2",
    title: "Policy 12.2 Student Code of Conduct: Academic Misconduct",
    publisher: "Laurier University Policies",
    url: "https://www.wlu.ca/about/governance/assets/resources/12.2-student-code-of-conduct.html",
    topics: "official academic misconduct policy definitions plagiarism cheating penalties sanctions first offence second offence transcript notation central registry",
  },
  {
    id: "policy-2-3",
    title: "Policy 2.3 Academic Accommodation of Students with Disabilities",
    publisher: "Laurier University Policies",
    url: "https://www.wlu.ca/about/governance/assets/resources/2.3-academic-accommodation-of-students-with-disabilities.html",
    topics: "disability academic accommodation policy documentation requirements responsibility of students faculty reasonable accommodation",
  },
  {
    id: "accessible-learning",
    title: "Accessible Learning",
    publisher: "Laurier Students: Accessible Learning",
    url: students("academics/support-and-advising/accessible-learning/index.html"),
    topics: "accessible learning centre register for accommodations exam accommodations disability extra time deadlines contact office hours",
  },
];

const TTL_S = 6 * 3600;
const PARSER_VERSION = 2; // bump when html.js changes so cached pages are parsed again
const USER_AGENT = "PC141-Course-Assistant/1.0 (+https://nobodyknownothing.github.io/WLU-RAG-Prototype/)";
const memory = new Map(); // url -> parsed page, per Worker instance

export async function loadPage(entry, ctx) {
  const hit = memory.get(entry.url);
  if (hit && Date.parse(hit.fetchedAt) + TTL_S * 1000 > Date.now()) return hit;
  const cache = globalThis.caches?.default;
  const key = `https://laurier-pages.cache/v${PARSER_VERSION}?u=${encodeURIComponent(entry.url)}`;
  let page = cache ? await cache.match(key).then((r) => r?.json()).catch(() => null) : null;
  if (!page) {
    const res = await fetch(entry.url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html" }, cf: { cacheTtl: TTL_S } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (/\/404\//.test(res.url)) throw new Error("page has moved (redirected to 404)");
    const sections = htmlToSections(await res.text());
    if (!sections.length) throw new Error("no readable content");
    page = { url: entry.url, fetchedAt: new Date().toISOString(), sections };
    if (cache) {
      const body = new Response(JSON.stringify(page), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${TTL_S}` } });
      ctx.waitUntil(cache.put(key, body).catch(() => {}));
    }
  }
  memory.set(entry.url, page);
  return page;
}

const routeIndex = new BM25(PAGES.map((p) => `${p.title} ${p.topics}`));
const pageText = (p) => `${p.title}. ${p.topics}`;

// Picks the pages worth fetching for a question: keyword matches against each page's topics that
// score close to the best one, plus (in full mode) the cross-encoder's top picks by rank.
async function routePages(query, mode, rerank) {
  const lexical = routeIndex.rank(query, 3);
  const best = lexical[0]?.[1] || 0;
  const picked = lexical.filter(([, s]) => s >= Math.max(ROUTE_MIN_BM25, best * 0.6)).map(([i]) => i);
  if (mode !== "simple") {
    const scored = await rerank(query, PAGES.map(pageText));
    picked.push(...scored.filter((r) => r.score >= ROUTE_MIN_RERANK).slice(0, 2).map((r) => r.index));
  }
  return [...new Set(picked)].slice(0, 4).map((i) => PAGES[i]);
}
const ROUTE_MIN_BM25 = 1.5;
const ROUTE_MIN_RERANK = 0.001;
const SECTION_MIN_RERANK = 0.01;
const RERANK_POOL = 30;

const deepLink = (url, s) => (s.anchor ? `${url}#${s.anchor}` : s.heading ? `${url}#:~:text=${encodeURIComponent(s.heading)}` : url);

// Returns { sources, pages }: the best sections (as citable sources) and which pages were checked.
export async function searchLaurier(query, { mode, k, ctx, rerank }) {
  const entries = await routePages(query, mode, rerank);
  const loaded = await Promise.all(
    entries.map((entry) =>
      loadPage(entry, ctx).then(
        (page) => ({ entry, page }),
        (e) => ({ entry, error: String(e.message || e) })
      )
    )
  );
  const pages = loaded.map(({ entry, page, error }) => ({
    id: entry.id,
    title: entry.title,
    publisher: entry.publisher,
    url: entry.url,
    ...(page ? { fetchedAt: page.fetchedAt, sections: page.sections.length } : { error }),
  }));
  const secs = loaded.flatMap(({ entry, page }) => (page ? page.sections.map((s) => ({ s, entry, page })) : []));
  if (!secs.length) return { sources: [], pages };

  const docText = ({ s, entry }) => `${entry.title} | ${s.path.join(" > ")}\n${s.text}`;
  const lexical = new BM25(secs.map(docText)).rank(query);
  let ranked;
  if (mode === "simple") {
    ranked = lexical.slice(0, k).map(([i, score]) => ({ i, score }));
  } else {
    const pool = [...new Set([...lexical.map(([i]) => i), ...secs.keys()])].slice(0, RERANK_POOL);
    const scored = await rerank(query, pool.map((i) => docText(secs[i])));
    ranked = scored.filter((r) => r.score >= SECTION_MIN_RERANK).slice(0, k).map((r) => ({ i: pool[r.index], score: r.score }));
  }
  const sources = ranked.map(({ i, score }) => {
    const { s, entry, page } = secs[i];
    return {
      kind: "laurier",
      pageId: entry.id,
      title: entry.title,
      publisher: entry.publisher,
      section: s.path.join(" > "),
      url: deepLink(entry.url, s),
      fetchedAt: page.fetchedAt,
      text: s.text,
      score,
    };
  });
  return { sources, pages };
}
