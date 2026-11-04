// Build worker/src/policies.json: every university policy and procedure listed in the wlu.ca
// sitemap, with its title, revision dates and a short summary for routing questions to it.
//
//   node scripts/build_policy_index.mjs            # only re-reads pages whose sitemap date changed
//   node scripts/build_policy_index.mjs --all      # re-read every page
//
// Policy 1.1 makes the University Secretariat the official repository; its public copies all live
// under /about/governance/assets/resources/, so the sitemap doubles as a policy register.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeEntities, htmlToSections, pageTitle } from "../worker/src/html.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "worker", "src", "policies.json");
const SITEMAP = "https://www.wlu.ca/sitemap.xml";
const PREFIX = "https://www.wlu.ca/about/governance/assets/resources/";
const USER_AGENT = "PC141-Course-Assistant/1.0 (+https://nobodyknownothing.github.io/WLU-RAG-Prototype/)";
const DELAY_MS = 1000; // one request a second
const SUMMARY_CHARS = 400;
const META = {
  approved: "Original Approval Date",
  revised: "Date of Most Recent Review/Revision",
  office: "Office of Accountability",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (i >= attempts) throw err;
      await sleep(DELAY_MS * 5 * i); // back off on dropped connections
    }
  }
}

// "5.1-business-expenses.html" -> policy 5.1; "procedures-for-...-7.14.html" -> procedure 7.14.
export function classify(url) {
  const slug = url.slice(url.lastIndexOf("/") + 1);
  const number = (slug.match(/^(\d{1,2}\.\d{1,2})-/) || slug.match(/-(\d{1,2}\.\d{1,2})\.html$/) || slug.match(/polic(?:y|ies)-(\d{1,2}\.\d{1,2})/) || [])[1] || null;
  const kind = slug.startsWith("sipp-") ? "investment" : slug.includes("procedure") ? "procedure" : /^\d{1,2}\.\d{1,2}-/.test(slug) ? "policy" : "other";
  return { slug, number, kind };
}

// The header fields every policy page opens with ("Date of Most Recent Review/Revision: ...").
export function policyMeta(html) {
  const text = decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");
  const labels = Object.values(META).join("|");
  const out = {};
  for (const [key, label] of Object.entries(META)) {
    const m = text.match(new RegExp(`${label.replace(/\//g, "\\/")}\\s*:\\s*(.+?)(?=\\s+(?:${labels.replace(/\//g, "\\/")}|Administrative Responsibility|Approving Authority|\\d\\.00)\\b|$)`));
    if (m) out[key] = m[1].trim().slice(0, 120);
  }
  return out;
}

// Opening text of the policy's Purpose section (or its first section), for matching questions.
function summary(html) {
  const sections = htmlToSections(html).filter((s) => !/^Overview$/.test(s.path[0]) || !/Print \| PDF/.test(s.text));
  const purpose = sections.find((s) => /purpose/i.test(s.path.join(" "))) || sections[0];
  return purpose ? purpose.text.replace(/\s+/g, " ").slice(0, SUMMARY_CHARS) : "";
}

async function main() {
  const all = process.argv.includes("--all");
  const previous = existsSync(OUT) && !all ? new Map(JSON.parse(readFileSync(OUT, "utf8")).map((p) => [p.url, p])) : new Map();
  const xml = await get(SITEMAP);
  const entries = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>\s*(?:<lastmod>\s*([^<\s]+)\s*<\/lastmod>)?/g)]
    .map(([, url, lastmod]) => ({ url, lastmod: lastmod || null }))
    .filter((e) => e.url.startsWith(PREFIX) && e.url.endsWith(".html"));

  const out = [];
  let fetched = 0;
  for (const e of entries) {
    const { slug, number, kind } = classify(e.url);
    if (kind === "investment") continue; // pension fund investment statements
    const old = previous.get(e.url);
    if (old && old.lastmod === e.lastmod) {
      out.push(old);
      continue;
    }
    try {
      if (fetched++) await sleep(DELAY_MS);
      const html = await get(e.url);
      out.push({ url: e.url, slug, number, kind, title: pageTitle(html) || slug, lastmod: e.lastmod, ...policyMeta(html), summary: summary(html) });
      console.log(`read ${number || "-"} ${kind} ${slug}`);
    } catch (err) {
      console.warn(`skipped ${e.url}: ${err.message}`);
      if (old) out.push(old);
    }
  }
  out.sort((a, b) => a.url.localeCompare(b.url));
  writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
  console.log(`wrote ${out.length} policies and procedures to ${OUT} (${fetched} pages read)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
