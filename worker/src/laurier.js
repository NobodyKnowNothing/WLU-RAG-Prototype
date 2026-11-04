// Official Laurier pages for university-wide policy. Pages are fetched live from wlu.ca when a
// question needs them, split into sections, and kept for a few hours per Worker instance.
//
// Pages come from three places, and the best sections across all of them are cited:
//   1. PAGES: hand-picked student-facing pages with topic hints (below).
//   2. Every university policy and procedure, from worker/src/policies.json (built from the
//      wlu.ca sitemap by scripts/build_policy_index.mjs).
//   3. Laurier's own site search, for any other public page on wlu.ca.
import { decodeEntities, htmlToSections } from "./html.js";
import policies from "./policies.json" with { type: "json" };
import { BM25, tokenize } from "./retrieval.js";

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

// How much weight a page carries: university policies and the Academic Calendar are the rules;
// other Laurier pages explain them.
export function authorityOf(url) {
  if (url.startsWith("https://www.wlu.ca/about/governance/")) return "policy";
  if (url.startsWith("https://academic-calendar.wlu.ca/")) return "calendar";
  return "guidance";
}

const policyByUrl = new Map(policies.map((p) => [p.url, p]));
const revisedOf = (url) => {
  const r = policyByUrl.get(url)?.revised;
  return r && !/^n\/?a$/i.test(r) ? r : undefined;
};
const curated = new Set(PAGES.map((p) => p.url));
// Hand-picked pages first, then every policy and procedure that isn't already one of them.
export const CATALOG = [
  ...PAGES,
  ...policies
    .filter((p) => !curated.has(p.url))
    .map((p) => ({
      id: `policy:${p.slug.replace(/\.html$/, "")}`,
      title: p.title,
      publisher: "Laurier University Policies",
      url: p.url,
      topics: `${p.kind}${p.number ? ` ${p.number}` : ""} ${p.summary}`,
    })),
].map((p) => ({ ...p, authority: authorityOf(p.url), revised: revisedOf(p.url) }));

const routeIndex = new BM25(CATALOG.map((p) => `${p.title} ${p.topics}`));
const pageText = (p) => `${p.title}. ${p.topics}`;

// Picks the pages worth fetching for a question: keyword matches against each page's title and
// topics that score close to the best one, plus (in full mode) the cross-encoder's top picks among
// the keyword candidates and the hand-picked pages.
async function routePages(query, mode, rerank) {
  const lexical = routeIndex.rank(query, ROUTE_POOL);
  const best = lexical[0]?.[1] || 0;
  const picked = lexical.slice(0, 4).filter(([, s]) => s >= Math.max(ROUTE_MIN_BM25, best * 0.6)).map(([i]) => i);
  if (mode !== "simple") {
    const pool = [...new Set([...lexical.map(([i]) => i), ...PAGES.keys()])];
    const scored = await rerank(query, pool.map((i) => pageText(CATALOG[i])));
    picked.push(...scored.filter((r) => r.score >= ROUTE_MIN_RERANK).slice(0, 2).map((r) => pool[r.index]));
  }
  return [...new Set(picked)].slice(0, 5).map((i) => CATALOG[i]);
}
const ROUTE_POOL = 20;
const ROUTE_MIN_BM25 = 1.5;
const ROUTE_MIN_RERANK = 0.001;
const SECTION_MIN_RERANK = 0.01;
const RERANK_POOL = 40;
const PER_PAGE_POOL = 6;

const deepLink = (url, s) => (s.anchor ? `${url}#${s.anchor}` : s.heading ? `${url}#:~:text=${encodeURIComponent(s.heading)}` : url);

// ---- Laurier site search -------------------------------------------------------------------
// The endpoint behind wlu.ca's own search box. It is not a published API, so it gets one request
// per question (like a student using the search box), results are cached for 6 hours, and
// SITE_SEARCH = "off" in wrangler.jsonc turns it off.
const SEARCH_API = "https://wlu.ca/_ato/_common/search-overlay/php/search-api.php";
const READABLE_HOSTS = /^https:\/\/(www\.|students\.|academic-calendar\.)?wlu\.ca\//;
const FILE = /\.(pdf|docx?|xlsx?|pptx?)(\?|$)|qualtrics\.com/i;
const searches = new Map(); // query -> { at, results }

export function parseSearchResults(html) {
  const results = [];
  for (const li of String(html || "").split(/<li\b[^>]*class="search-result"/).slice(1)) {
    const a = li.match(/<a\b[^>]*class="search-title"[^>]*>([\s\S]*?)<\/a>/);
    const href = a && a[0].match(/\bhref="([^"]+)"/);
    if (!href) continue;
    const strip = (s) => decodeEntities(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
    const snippet = li.match(/class="search-snippet"[^>]*>([\s\S]*?)<\/div>/);
    results.push({ title: strip(a[1]).split(" | ")[0], url: decodeEntities(href[1]), snippet: snippet ? strip(snippet[1]) : "" });
  }
  return results;
}

async function siteSearch(question) {
  const query = (question.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => tokenize(w).length).join(" ");
  const hit = searches.get(query);
  if (hit && hit.at + TTL_S * 1000 > Date.now()) return hit.results;
  const res = await fetch(SEARCH_API, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ query, page: "1", search_filter: "", search_sort: "" }),
  });
  if (!res.ok) throw new Error(`site search HTTP ${res.status}`);
  const results = parseSearchResults((await res.json()).search_results);
  searches.set(query, { at: Date.now(), results });
  return results;
}

// Returns { sources, pages, links }: the best sections (as citable sources), which pages were
// checked, and files or forms the site search found but that can't be read and quoted.
export async function searchLaurier(query, { question = query, mode, k, ctx, rerank, siteSearchOn = true }) {
  const entries = await routePages(query, mode, rerank);
  // Keyword overlap can't tell a page that answers the question from one that merely mentions its
  // words ("order a transcript" vs the policy on what a transcript contains), so Laurier's own
  // search runs alongside the catalog and the section ranking below picks from both.
  const have = new Set(entries.map((e) => e.url));
  const attempt = (p) => p.catch((e) => ({ loaded: [], links: [], error: String(e.message || e) }));
  const [catalogPages, search] = await Promise.all([loadAll(entries, ctx), siteSearchOn ? attempt(fromSiteSearch(question, have, ctx)) : null]);
  const loaded = [...catalogPages, ...(search?.loaded || [])];
  const { secs, ranked } = await rankSections(loaded, query, mode, k, rerank);
  const links = search?.links || [];
  const searchError = search?.error;

  const pages = loaded.map(({ entry, page, error, viaSearch }) => ({
    id: entry.id,
    title: entry.title,
    publisher: entry.publisher,
    url: entry.url,
    authority: entry.authority,
    ...(viaSearch && { viaSearch }),
    ...(page ? { fetchedAt: page.fetchedAt, sections: page.sections.length } : { error }),
  }));
  if (searchError) pages.push({ id: "site-search", title: "Laurier site search", url: "https://www.wlu.ca/search.html", error: searchError });
  const sources = ranked.map(({ i, score }) => {
    const { s, entry, page, viaSearch } = secs[i];
    return {
      kind: "laurier",
      pageId: entry.id,
      title: entry.title,
      publisher: entry.publisher,
      authority: entry.authority,
      ...(entry.revised && { revised: entry.revised }),
      ...(viaSearch && { viaSearch }),
      section: s.path.join(" > "),
      url: deepLink(entry.url, s),
      fetchedAt: page.fetchedAt,
      text: s.text,
      score,
    };
  });
  return { sources, pages, links };
}

// Reads the top two web pages the site search finds (that aren't already loaded) and lists the
// files and forms it finds as links, since those can't be read and quoted.
async function fromSiteSearch(question, have, ctx) {
  const results = (await siteSearch(question)).filter((r) => READABLE_HOSTS.test(r.url) || FILE.test(r.url));
  const wantsFile = /\b(forms?|application|template|pdf|documents?|files?|rubrics?)\b/i.test(question);
  const links = wantsFile ? results.filter((r) => FILE.test(r.url)).slice(0, 3).map(({ title, url }) => ({ title, url })) : [];
  const extra = results
    .filter((r) => !FILE.test(r.url) && !have.has(r.url.split("#")[0]))
    .slice(0, 2)
    .map((r) => CATALOG.find((p) => p.url === r.url) || { id: `search:${r.url}`, title: r.title, publisher: new URL(r.url).hostname.replace(/^www\./, ""), url: r.url, authority: authorityOf(r.url), revised: revisedOf(r.url) });
  return { loaded: await loadAll(extra, ctx, true), links };
}

const loadAll = (entries, ctx, viaSearch = false) =>
  Promise.all(
    entries.map((entry) =>
      loadPage(entry, ctx).then(
        (page) => ({ entry, page, viaSearch }),
        (e) => ({ entry, error: String(e.message || e), viaSearch })
      )
    )
  );

async function rankSections(loaded, query, mode, k, rerank) {
  const secs = loaded.flatMap(({ entry, page, viaSearch }) => (page ? page.sections.map((s) => ({ s, entry, page, viaSearch })) : []));
  if (!secs.length) return { secs, ranked: [] };
  const docText = ({ s, entry }) => `${entry.title} | ${s.path.join(" > ")}\n${s.text}`;
  const lexical = new BM25(secs.map(docText)).rank(query);
  if (mode === "simple") {
    // Keyword scores aren't comparable across unrelated pages (a co-op page that repeats "code of
    // conduct" can outscore the policy itself), so site search results get one slot, not all.
    const catalog = lexical.filter(([i]) => !secs[i].viaSearch);
    const web = lexical.filter(([i]) => secs[i].viaSearch);
    const picked = [...catalog.slice(0, k - Math.min(1, web.length)), ...web].slice(0, k);
    return { secs, ranked: picked.map(([i, score]) => ({ i, score })) };
  }
  // Each page's best few sections go to the cross-encoder, so one page that repeats the question's
  // words can't crowd the others out of the pool.
  const perPage = new Map();
  for (const i of [...lexical.map(([i]) => i), ...secs.keys()]) {
    const url = secs[i].entry.url;
    if (!perPage.has(url)) perPage.set(url, []);
    const list = perPage.get(url);
    if (list.length < PER_PAGE_POOL && !list.includes(i)) list.push(i);
  }
  const pool = [...perPage.values()].flat().slice(0, RERANK_POOL);
  const scored = await rerank(query, pool.map((i) => docText(secs[i])));
  return { secs, ranked: scored.filter((r) => r.score >= SECTION_MIN_RERANK).slice(0, k).map((r) => ({ i: pool[r.index], score: r.score })) };
}
