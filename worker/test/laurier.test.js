import assert from "node:assert/strict";
import { test } from "node:test";
import { buildUserMessage } from "../src/answer.js";
import { CATALOG, PAGES, authorityOf, isNewsPost, parseSearchResults, publisherOf } from "../src/laurier.js";

test("site search results are parsed from the endpoint's HTML", () => {
  const html = `<li class="search-result">
      <div class="flexbox"><a class="search-title" target="_blank" href="https://students.wlu.ca/academics/exams/deferred-exams.html"><strong>Deferred Exams</strong> | Students - Wilfrid Laurier University</a></div>
      <div class="search-url" aria-hidden="true">students.wlu.ca/academics/exams/deferred-exams.html</div>
      <div class="search-snippet">A final <strong>examination</strong> cannot be deferred more than twice&nbsp;...</div>
    </li><li class="search-result">
      <a class="search-title" href="https://students.wlu.ca/common/forms/withdrawal.pdf">Withdrawal &amp; Refund Form</a>
    </li>`;
  assert.deepEqual(parseSearchResults(html), [
    { title: "Deferred Exams", url: "https://students.wlu.ca/academics/exams/deferred-exams.html", snippet: "A final examination cannot be deferred more than twice ..." },
    { title: "Withdrawal & Refund Form", url: "https://students.wlu.ca/common/forms/withdrawal.pdf", snippet: "" },
  ]);
  assert.deepEqual(parseSearchResults(""), []);
});

test("pages found by site search are named after their site area", () => {
  const found = { id: "search:https://students.wlu.ca/x.html", url: "https://students.wlu.ca/x.html", publisher: "students.wlu.ca" };
  assert.equal(publisherOf(found, { area: "Accessible Learning" }), "Laurier Students: Accessible Learning");
  assert.equal(publisherOf(found, { area: "" }), "students.wlu.ca");
  assert.equal(publisherOf(PAGES[0], { area: "Something" }), PAGES[0].publisher);
});

test("dated news posts found by site search are not read as sources", () => {
  assert.equal(isNewsPost("https://students.wlu.ca/academics/records-and-registration/news/2023/winter/fall-2022-official-grades-released.html"), true);
  assert.equal(isNewsPost("https://www.wlu.ca/news/news-releases/2026/oct/x.html"), true);
  assert.equal(isNewsPost("https://students.wlu.ca/academics/records-and-registration/student-records/index.html"), false);
  assert.equal(isNewsPost("https://students.wlu.ca/campus-life/newsletters.html"), false);
});

test("sources are ranked by authority: policies and the calendar are rules, the rest is guidance", () => {
  assert.equal(authorityOf("https://www.wlu.ca/about/governance/assets/resources/12.2-student-code-of-conduct.html"), "policy");
  assert.equal(authorityOf("https://academic-calendar.wlu.ca/section.php?cal=1&s=1174&sp=3905&ss=4668&y=93"), "calendar");
  assert.equal(authorityOf("https://students.wlu.ca/academics/exams/deferred-exams.html"), "guidance");
});

test("the catalog keeps the hand-picked pages and adds every other policy once", () => {
  assert.deepEqual(CATALOG.slice(0, PAGES.length).map((p) => p.id), PAGES.map((p) => p.id));
  const urls = CATALOG.map((p) => p.url);
  assert.equal(new Set(urls).size, urls.length);
  const policies = CATALOG.filter((p) => p.authority === "policy");
  assert.ok(policies.length > 100);
  assert.ok(policies.some((p) => /12\.3 Non-Academic Student Code of Conduct/.test(p.title)));
  assert.ok(policies.every((p) => p.title && p.topics));
});

test("the prompt tells the model what kind of Laurier page each source is", () => {
  const msg = buildUserMessage("What happens if I'm accused of cheating?", [
    { n: 1, kind: "laurier", authority: "policy", revised: "November 27, 2024", title: "12.2 Student Code of Conduct", section: "4.04 Penalties", publisher: "Laurier University Policies", text: "..." },
    { n: 2, kind: "laurier", authority: "guidance", title: "Academic Misconduct Procedures", section: "Overview", publisher: "Laurier Students", text: "..." },
  ]);
  assert.match(msg, /\[1\] LAURIER, university policy, last revised November 27, 2024 \|/);
  assert.match(msg, /\[2\] LAURIER, guidance page \|/);
});
