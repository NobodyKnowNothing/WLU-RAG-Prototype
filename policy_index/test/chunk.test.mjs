import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkPage, clauseRange, deepLink, fixNumberedPath, linearizeTables, splitText, textFragment } from "../src/chunk.mjs";
import { citationOf } from "../src/cite.mjs";
import { pageRecord, parseSitemap, registerLinks } from "../src/sources.mjs";
import { BASE, PAGES } from "./helpers.mjs";

const URL_12_2 = `${BASE}12.2-student-code-of-conduct.html`;

test("policy pages become one chunk per section with citations and deep links", () => {
  const { title, chunks } = chunkPage(PAGES[URL_12_2], { pageId: "policy:12.2", url: URL_12_2 });
  assert.equal(title, "12.2 Student Code of Conduct: Academic Misconduct");
  assert.deepEqual(chunks.map((c) => c.section), ["Overview", "1.00 Purpose", "2.00 Definitions", "4.00 Policy", "5.00 Penalties", "Appendix: Penalty Guidelines"]);
  const defs = chunks.find((c) => c.section === "2.00 Definitions");
  assert.equal(defs.clauses, "2.01–2.02");
  assert.equal(defs.url, `${URL_12_2}#:~:text=2.00%20Definitions`);
  assert.equal(citationOf({ title, ...defs }), "12.2 Student Code of Conduct: Academic Misconduct > 2.00 Definitions, 2.01–2.02");
  assert.equal(defs.enriched, `${title} | 2.00 Definitions\n${defs.text}`);
  // the disclaimer and the Print | PDF line are gone; the approval dates stay
  assert.ok(!chunks.some((c) => /online version is for convenience|Print \| PDF/.test(c.text)));
  assert.match(chunks[0].text, /Date of Most Recent Review\/Revision: June 2, 2024/);
});

test("chunk ids depend on page and section, not on text", () => {
  const a = chunkPage(PAGES[URL_12_2], { pageId: "p", url: URL_12_2 }).chunks;
  const edited = PAGES[URL_12_2].replace("written warning", "formal written warning");
  const b = chunkPage(edited, { pageId: "p", url: URL_12_2 }).chunks;
  assert.deepEqual(a.map((c) => c.id), b.map((c) => c.id));
  assert.equal(a.filter((c, i) => c.text !== b[i].text).length, 1);
  assert.equal(new Set(a.map((c) => c.id)).size, a.length);
});

test("tables with column headers keep each cell with its row and column", () => {
  const { chunks } = chunkPage(PAGES[URL_12_2], { pageId: "p", url: URL_12_2 });
  const grid = chunks.find((c) => c.section === "Appendix: Penalty Guidelines").text.split("\n");
  assert.deepEqual(grid, ["Plagiarism", "Minor – First Offence: Written warning. Resubmission.", "Minor – Second Offence: Zero in the course.", "Major – First Offence: Zero on the work.", "Major – Second Offence: Expulsion."]);
  // two-column tables are left for html.js
  const two = "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>";
  assert.equal(linearizeTables(two), two);
});

test("numbered headings nest by their numbers", () => {
  assert.deepEqual(fixNumberedPath(["4.00 Policy", "5.00 Roles"]), ["5.00 Roles"]);
  assert.deepEqual(fixNumberedPath(["4.00 Policy", "4.01 General", "4.01.02 Access"]), ["4.00 Policy", "4.01 General", "4.01.02 Access"]);
  assert.deepEqual(fixNumberedPath(["4.00 Policy", "4.01 General", "4.02 Personal"]), ["4.00 Policy", "4.02 Personal"]);
  assert.deepEqual(fixNumberedPath(["Appendix: Penalties", "A First Offence"]), ["Appendix: Penalties", "A First Offence"]);
  assert.deepEqual(fixNumberedPath(["Brantford", "2.00 Scope", "3.00 Policy"]), ["Brantford", "3.00 Policy"]);
});

test("long sections split into balanced parts that start at clauses", () => {
  const clauses = Array.from({ length: 12 }, (_, i) => `4.${String(i + 1).padStart(2, "0")} ${"Lorem ipsum dolor sit amet. ".repeat(8).trim()}`);
  const parts = splitText(clauses.join("\n"), 1500);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => p.length <= 1500 && /^4\.\d\d /.test(p)));
  const sizes = parts.map((p) => p.length);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) < 700, `unbalanced parts: ${sizes}`);
  assert.equal(clauseRange(parts[0]), `4.01–${parts[0].split("\n").at(-1).slice(0, 4)}`);
  assert.equal(clauseRange("no numbers here"), "");
});

test("deep links use anchors, headings, or a later part's first words", () => {
  assert.equal(deepLink("u", { anchor: "x", heading: "H" }, "t", 0), "u#x");
  assert.equal(deepLink("u", { anchor: "", heading: "Grades - Appeals" }, "t", 0), "u#:~:text=Grades%20%2D%20Appeals");
  assert.equal(deepLink("u", { anchor: "", heading: "" }, "t", 0), "u");
  assert.equal(deepLink("u", { anchor: "x", heading: "H" }, "• 4.02.08 Improper access and/or obstruction, which involves hiding", 1), "u#:~:text=4.02.08%20Improper%20access%20and%2For%20obstruction%2C%20which");
  assert.equal(textFragment("a-b, c&d"), "#:~:text=a%2Db%2C%20c%26d");
  // a one-word heading appears all over a page, so the link goes to the section's first words
  assert.equal(deepLink("u", { anchor: "", heading: "Policy" }, "4.00 Instructors may set rules for devices in class.", 0), "u#:~:text=4.00%20Instructors%20may%20set%20rules%20for");
  assert.equal(deepLink("u", { anchor: "", heading: "Penalties" }, "Minor – First Offence: Written warning.", 1), "u#:~:text=Minor");
});

test("sitemap, register links and page records", () => {
  assert.deepEqual(parseSitemap("<url><loc>https://a/x.html</loc><lastmod>2025-10-28</lastmod></url><url><loc>https://a/y.html</loc></url>"), [
    { url: "https://a/x.html", lastmod: "2025-10-28" },
    { url: "https://a/y.html", lastmod: null },
  ]);
  const reg = registerLinks(`<a href="assets/resources/1.1-x.html">1.1</a><a href="../discover/assets/resources/frame.html#top">f</a><a href="assets/resources/form.pdf">pdf</a><a href="https://example.com/assets/resources/z.html">z</a>`);
  assert.deepEqual(reg, ["https://www.wlu.ca/about/governance/assets/resources/1.1-x.html", "https://www.wlu.ca/about/discover/assets/resources/frame.html"]);
  const withMenu = `<nav><a href="../president/assets/resources/annual-report.html">Report</a></nav><main><a href="assets/resources/2.3-x.html">2.3</a></main>`;
  assert.deepEqual(registerLinks(withMenu), ["https://www.wlu.ca/about/governance/assets/resources/2.3-x.html"]);
  const rec = pageRecord({ pageId: "policy:12.2", url: URL_12_2, lastmod: "2026-01-01", origin: "sitemap" }, PAGES[URL_12_2], "12.2 Student Code of Conduct");
  assert.equal(rec.kind, "policy");
  assert.equal(rec.number, "12.2");
  assert.equal(rec.authority, "policy");
  assert.equal(rec.revised, "June 2, 2024");
  assert.equal(rec.publisher, "Laurier University Policies");
  const proc = pageRecord({ pageId: "x", url: `${BASE}procedures-for-smoke-free-policy-7.8.html`, origin: "sitemap" }, PAGES[URL_12_2], "Procedures");
  assert.equal(proc.kind, "procedure");
  assert.equal(proc.number, "7.8");
  const cal = pageRecord({ pageId: "exams", url: "https://academic-calendar.wlu.ca/section.php?x", publisher: "Undergraduate Academic Calendar 2026/27", origin: "curated" }, "<p></p>", "Examinations");
  assert.equal(cal.kind, "calendar");
  assert.equal(cal.revised, null);
});
