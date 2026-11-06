// Which pages go in the index, and how they are fetched.
//
//   - every policy and procedure under /about/governance/assets/resources/ in the wlu.ca sitemap
//     (Policy 1.1 makes the Secretariat the official repository; procedures are only linked from
//     their policies, so the sitemap is more complete than the register page),
//   - anything else the policy register page (/about/governance/policies.html) links to under an
//     assets/resources/ folder,
//   - the assistant's hand-picked student pages (Academic Calendar, students.wlu.ca), from
//     worker/src/laurier.js, with the same ids, titles and publishers the Worker uses.
import { authorityOf, PAGES } from "../../worker/src/laurier.js";
import { classify, policyMeta } from "../../scripts/build_policy_index.mjs";

export const SITEMAP = "https://www.wlu.ca/sitemap.xml";
export const REGISTER = "https://www.wlu.ca/about/governance/policies.html";
export const POLICY_PREFIX = "https://www.wlu.ca/about/governance/assets/resources/";
export const USER_AGENT = "PC141-Course-Assistant/1.0 (+https://nobodyknownothing.github.io/WLU-RAG-Prototype/)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A polite fetcher: one request at a time, `delayMs` apart, retried with backoff on network errors
// and 5xx/429. Returns { status, url (after redirects), text }.
export function politeFetcher({ delayMs = 1000, attempts = 3, timeoutMs = 30000, fetchImpl = fetch } = {}) {
  let last = 0;
  return async function get(url) {
    for (let i = 1; ; i++) {
      const wait = last + delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      try {
        const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xml" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
        if ((res.status >= 500 || res.status === 429) && i < attempts) throw new Error(`HTTP ${res.status}`);
        return { status: res.status, url: res.url || url, text: res.ok ? await res.text() : "" };
      } catch (err) {
        if (i >= attempts) throw err;
        await sleep(delayMs * 5 * i);
      }
    }
  };
}

const policyPageId = (url) => `policy:${url.slice(url.lastIndexOf("/") + 1).replace(/\.html$/, "")}`;

export function parseSitemap(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>\s*(?:<lastmod>\s*([^<\s]+)\s*<\/lastmod>)?/g)].map(([, url, lastmod]) => ({ url: url.replace(/&amp;/g, "&"), lastmod: lastmod || null }));
}

// Links in the register's main content (the site menu around it links to reports and frameworks
// that are not policies).
export function registerLinks(html, base = REGISTER) {
  const main = (html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i) || [])[1] ?? html;
  const out = new Set();
  for (const [, href] of main.matchAll(/href="([^"#]+)/g)) {
    try {
      const u = new URL(href.replace(/&amp;/g, "&"), base);
      if (/^(www\.)?wlu\.ca$/.test(u.hostname) && /\/assets\/resources\/[^/]+\.html$/.test(u.pathname)) out.add(`https://www.wlu.ca${u.pathname}`);
    } catch {
      // not a URL
    }
  }
  return [...out];
}

// -> [{ pageId, url, lastmod, origin, title?, publisher?, curated? }], deduplicated by URL. A
// hand-picked page that is also a policy keeps its hand-picked id, title and publisher.
export async function discover(get, { curated = PAGES, includeRegister = true } = {}) {
  const sitemap = await get(SITEMAP);
  if (sitemap.status !== 200) throw new Error(`sitemap: HTTP ${sitemap.status}`);
  const fromSitemap = parseSitemap(sitemap.text).filter((e) => e.url.startsWith(POLICY_PREFIX) && e.url.endsWith(".html"));
  const targets = new Map();
  const add = (t) => targets.has(t.url) || targets.set(t.url, t);
  for (const p of curated) add({ pageId: p.id, url: p.url, lastmod: null, origin: "curated", title: p.title, publisher: p.publisher, curated: true });
  const investment = (url) => classify(url).kind === "investment"; // pension fund investment statements
  for (const e of fromSitemap) {
    if (investment(e.url)) continue;
    const t = targets.get(e.url);
    if (t) t.lastmod = e.lastmod;
    else add({ pageId: policyPageId(e.url), url: e.url, lastmod: e.lastmod, origin: "sitemap" });
  }
  if (includeRegister) {
    const reg = await get(REGISTER);
    if (reg.status === 200) for (const url of registerLinks(reg.text)) if (!investment(url)) add({ pageId: policyPageId(url), url, lastmod: null, origin: "register" });
  }
  return [...targets.values()];
}

// Page-level facts stored with each page and shown in citations.
export function pageRecord(target, html, title) {
  const isPolicy = target.url.startsWith(POLICY_PREFIX);
  const { number, kind } = isPolicy ? classify(target.url) : { number: null, kind: null };
  const meta = isPolicy ? policyMeta(html) : {};
  const authority = authorityOf(target.url);
  return {
    page_id: target.pageId,
    url: target.url,
    title,
    publisher: target.publisher || (isPolicy ? "Laurier University Policies" : "Laurier"),
    authority,
    kind: kind || authority, // policy | procedure | other | calendar | guidance
    number: number || (title.match(/^(?:Policy\s+)?(\d{1,2}\.\d{1,2})\b/) || [])[1] || null,
    approved: meta.approved || null,
    revised: meta.revised && !/^n\/?a$/i.test(meta.revised) ? meta.revised : null,
    office: meta.office || null,
    lastmod: target.lastmod || null,
    origin: target.origin,
  };
}
