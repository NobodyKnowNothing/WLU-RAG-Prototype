import assert from "node:assert/strict";
import { test } from "node:test";
import { buildUserMessage } from "../src/answer.js";
import { CATALOG, PAGES, authorityOf, parseSearchResults } from "../src/laurier.js";

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
