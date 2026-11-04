import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeEntities, htmlToSections, pageTitle } from "../src/html.js";

const CALENDAR = `<html><body><div class="sidebar">Navigation</div>
<div class="content">
<h1>Examinations</h1>
<p>Website: <a href="https://students.wlu.ca/academics/exams/index.html">exams</a></p>
<div class="reqs"><div class="greyheading">Anchors</div><ul class="proginfo"><li><a href="#Deferred">Deferred</a></li></ul></div>
<div class="reqs">
<div class="heading"><A name="Deferred_Examination_Policy"></A>Deferred Examination Policy</div>
<p>Final examinations for any <A href="glossary.php?g=1" class="glossaryTerm" onMouseOver="showGlossaryDef(this,'<P>A unit of study <a href=#QUOTE#x#QUOTE#>more</a></P>')" onMouseOut="hideGlossaryDef()">course</A> cannot be
deferred more than twice.</p>
<div class="returntotop"><a href="#top">Top</a></div>
</div>
</div> <!-- /.content -->
<div id="contentRHS">Other calendars</div></body></html>`;

test("calendar pages keep section anchors and drop glossary tooltips and jump lists", () => {
  const secs = htmlToSections(CALENDAR);
  assert.equal(pageTitle(CALENDAR), "Examinations");
  assert.deepEqual(secs.map((s) => s.path), [["Overview"], ["Deferred Examination Policy"]]);
  const deferred = secs[1];
  assert.equal(deferred.anchor, "Deferred_Examination_Policy");
  assert.equal(deferred.text, "Final examinations for any course cannot be deferred more than twice.");
  assert.ok(!secs.some((s) => /Anchors|Top|Other calendars|unit of study/.test(s.text)));
});

test("main-content pages nest h2/h3 headings and read accordion buttons", () => {
  const html = `<header>Site menu</header><main id="maincontent">
    <div class="page-title"><h1>Deferred Exams</h1></div>
    <ul><li><a href="/">Home</a></li><li><a href="/x">Exams</a></li></ul>
    <p>Deferred examinations may be granted in limited circumstances.</p>
    <h2>Deferred Final Exams</h2><p>Students are expected to write the final exam.</p>
    <h3 class="accordion-header"><button type="button"><span>Medical Grounds</span></button></h3>
    <div class="accordion-panel"><p>Submit a petition within <strong>five</strong> business days.</p></div>
    <h3><a id="alc"></a>Accessible Learning</h3><ul><li>Book through the portal.</li></ul>
  </main><footer>Contact</footer>`;
  const secs = htmlToSections(html);
  assert.deepEqual(secs.map((s) => s.path.join(" > ")), [
    "Overview",
    "Deferred Final Exams",
    "Deferred Final Exams > Medical Grounds",
    "Deferred Final Exams > Accessible Learning",
  ]);
  assert.equal(secs[0].text, "Deferred examinations may be granted in limited circumstances.");
  assert.equal(secs[2].text, "Submit a petition within five business days.");
  assert.equal(secs[3].anchor, "alc");
  assert.equal(secs[3].text, "• Book through the portal.");
});

test("calendar date tables become dated sentences", () => {
  const html = `<div class="content"><h1>Dates</h1><table>
    <tr><th colspan="2"><A name="26-10"></A>October, 2026</th></tr>
    <tr class="zebra"><td width="50">12</td><td>
      Thanksgiving (statutory holiday), no classes</td></tr>
    <tr><td>Oct 13 - Oct 16</td><td>Fall Reading Week, no classes</td></tr>
  </table></div> <!-- /.content -->`;
  const [oct] = htmlToSections(html);
  assert.equal(oct.anchor, "26-10");
  assert.equal(oct.text, "October 12, 2026: Thanksgiving (statutory holiday), no classes\nOct 13 - Oct 16, 2026: Fall Reading Week, no classes");
});

test("long sections are split at line boundaries", () => {
  const para = `<p>${"word ".repeat(120)}</p>`;
  const secs = htmlToSections(`<main><h2>Long</h2>${para.repeat(6)}</main>`);
  assert.ok(secs.length > 1);
  assert.ok(secs.every((s) => s.path[0] === "Long" && s.text.length <= 1500));
  const oneLine = htmlToSections(`<main><h2>Run-on</h2><p>${"word ".repeat(800)}</p></main>`);
  assert.equal(oneLine.length, 3);
  assert.ok(oneLine.every((s) => s.text.length <= 1500 && s.text.startsWith("word")));
});

test("decodes named and numeric entities", () => {
  assert.equal(decodeEntities("Students&#8217; rights &amp; duties&nbsp;&#x2014; &rsquo;"), "Students’ rights & duties — ’");
});
