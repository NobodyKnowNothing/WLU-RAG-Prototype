import assert from "node:assert/strict";
import { test } from "node:test";
import { answerText, buildUserMessage, quoteFound, verifyAnswer } from "../src/answer.js";
import { BM25, expandQuery, rrf, stem } from "../src/retrieval.js";

const SOURCES = [
  { n: 1, kind: "pc141", title: "PC141 Lab Syllabus (Fall 2026)", section: "Requirements and Policies > Plagiarism Policy", pages: [4], text: "• Consequences: plagiarism will result in a grade of zero on the affected lab." },
  { n: 2, kind: "pc141", title: "PC141 Lab Announcements (MyLS)", section: "Intro, Lab 1 > Laboratory Schedule", pages: [2], intro: "Laboratory sessions are held on alternate weeks in Room N2089.", text: "PC141–L04 September 16 Wednesday 8:30 am – 10:20 am" },
  { n: 3, kind: "laurier", title: "Policy 12.2 Student Code of Conduct", section: "4.01 Academic Misconduct", publisher: "Laurier University Policies", text: "4.02.01 Plagiarism, which is the unacknowledged presentation of the work of others as one's own;" },
];

test("quotes match despite PDF spacing, dashes and ellipses", () => {
  assert.ok(quoteFound("PC141-L04 September 16 Wednesday 8:30 am - 10:20 am", [SOURCES[1].text]));
  assert.ok(quoteFound("plagiarism will result in a grade of zero ... affected lab", [SOURCES[0].text]));
  assert.ok(!quoteFound("plagiarism will result in a failing grade for the course", [SOURCES[0].text]));
  assert.ok(!quoteFound("", [SOURCES[0].text]));
});

test("verified claims keep their bucket and the answer counts as answered", () => {
  const v = verifyAnswer(
    {
      status: "answered",
      pc141: [{ text: "Your L04 lab is Wednesday, September 16, 8:30 am to 10:20 am [2].", quote: "PC141–L04 September 16 Wednesday 8:30 am – 10:20 am", sources: [2] }],
      laurier: [{ text: "Plagiarism is presenting others' work as your own.", quote: "the unacknowledged presentation of the work of others as one's own", sources: [3] }],
      unverified: "none",
    },
    SOURCES
  );
  assert.equal(v.status, "answered");
  assert.equal(v.unverified, "");
  assert.equal(v.pc141[0].text, "Your L04 lab is Wednesday, September 16, 8:30 am to 10:20 am.");
  assert.ok(v.pc141[0].verified && v.laurier[0].verified);
});

test("announcement openings count as part of the cited source", () => {
  const v = verifyAnswer({ status: "answered", pc141: [{ text: "Labs are held in Room N2089.", quote: "held on alternate weeks in Room N2089", sources: [2] }], laurier: [], unverified: "" }, SOURCES);
  assert.ok(v.pc141[0].verified);
});

test("uncited claims are dropped and invented numbers are flagged", () => {
  const v = verifyAnswer(
    {
      status: "answered",
      pc141: [
        { text: "Late labs lose 10% per day.", quote: "", sources: [] },
        { text: "Plagiarism gets a grade of zero and a 2 week suspension.", quote: "plagiarism will result in a grade of zero", sources: [1] },
      ],
      laurier: [],
      unverified: "",
    },
    SOURCES
  );
  assert.equal(v.status, "partial");
  assert.equal(v.pc141.length, 1);
  assert.equal(v.pc141[0].verified, false);
  assert.match(v.pc141[0].issue, /"2"/);
  assert.match(v.unverified, /1 statement was removed/);
});

test("a claim citing a Laurier page is never shown as a PC141 rule", () => {
  const v = verifyAnswer({ status: "answered", pc141: [{ text: "Plagiarism is misconduct.", quote: "Plagiarism, which is the unacknowledged presentation", sources: [3] }], laurier: [], unverified: "" }, SOURCES);
  assert.equal(v.pc141.length, 0);
  assert.equal(v.laurier.length, 1);
});

test("no supported claims means not_found with an explanation", () => {
  const v = verifyAnswer({ status: "answered", pc141: [{ text: "The final is worth 40%.", quote: "final exam 40%", sources: [9] }], laurier: [], unverified: "" }, SOURCES);
  assert.equal(v.status, "not_found");
  assert.ok(v.unverified.length > 0);
  assert.match(answerText(v), /^Could not verify:/);
});

test("the prompt labels each source with its kind, section and the student's sections", () => {
  const msg = buildUserMessage("When is my lab?", SOURCES, { lab: "L04" });
  assert.match(msg, /Student's registered sections: lab PC141-L04/);
  assert.match(msg, /\[2\] PC141 \| PC141 Lab Announcements \(MyLS\) > Intro, Lab 1 > Laboratory Schedule, p\. 2\n\(Announcement opening: Laboratory sessions/);
  assert.match(msg, /\[3\] LAURIER \| Policy 12\.2 Student Code of Conduct > 4\.01 Academic Misconduct \(Laurier University Policies\)/);
});

test("stemming, BM25, fusion and query expansion", () => {
  assert.deepEqual(["missed", "missing", "labs", "submitted", "classes", "policies"].map(stem), ["miss", "miss", "lab", "submit", "class", "policy"]);
  const bm = new BM25(["Attendance and makeup policy for missed labs", "Logarithmic scale and orders of magnitude", "Plagiarism policy"]);
  assert.equal(bm.rank("What if I miss a lab?")[0][0], 0);
  assert.deepEqual(bm.rank("unrelated words"), []);
  assert.deepEqual(rrf([[[2, 9], [0, 5]], [[0, 1], [1, 0.5]]]), [0, 2, 1]);
  assert.match(expandQuery("Can I use ChatGPT?"), /AI-based systems/);
  assert.equal(expandQuery("When is reading week?"), "When is reading week?");
});
