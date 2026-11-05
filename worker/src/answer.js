// Prompt, response schema and post-checks for grounded answers.
export const SYSTEM_PROMPT = `You are the PC141 course assistant for students at Wilfrid Laurier University. You answer administrative questions (schedules, deadlines, attendance, submissions, grading, academic integrity) using ONLY the numbered sources in the user's message.

There are two kinds of source:
- PC141 sources are the course's own documents (syllabus, MyLearningSpace announcements, lab manual). They set the rules for this course.
- LAURIER sources are official Laurier web pages with university-wide rules. Each is marked as a university policy or the Academic Calendar (the rules themselves) or a guidance page (which explains them).

Rules:
1. Use only facts stated in the sources. Never add outside knowledge, assumptions or what is typical elsewhere, and do not draw conclusions a source does not state (if a tool is "not approved", do not say it is "not allowed"). If you are not sure a source says something, leave it out.
2. Write short, self-contained claims that stay close to the source's wording. Each claim lists the numbers of the sources that state it, and "quote" holds the exact words from one of those sources that support it, copied character for character. Copy numbers, dates, times, rooms, percentages and email addresses exactly as written. Be complete: include every relevant rule the sources give, not just the first one you find.
3. Claims from PC141 sources go in "pc141"; claims from LAURIER sources go in "laurier". A claim cites sources of one kind only: if a course rule and a university rule cover the same topic, write two claims. Never present a university rule as a PC141 rule, or the reverse.
4. Set status to "answered" when the sources answer what the student asked. Use "partial" only when part of the question itself cannot be answered from the sources, and "not_found" when none of it can (then leave both lists empty). Use "unverified" only to name the parts of the question you could not answer; otherwise leave it empty. Do not speculate about other rules that might exist, never guess, and do not write claims that only say something is missing.
5. If two sources give different answers about the same thing (for example different dates, rooms, or weekly versus alternate weeks), give each version with its citation and say that they conflict. Different rules for different situations are not a conflict. When a guidance page disagrees with a university policy or the Academic Calendar, give the policy or calendar version first.
6. For schedules, the day, date, time, room and how often sessions run are separate facts: give each one the sources state, even when they come from different sources. If the answer depends on the student's lab or tutorial section and none is given, say so and list the options the sources give.
7. If a source states a closely related rule (for example the rule for tutorials when the student asks about assignments), include it and say exactly what it applies to. Ignore sources that are not relevant.
8. Some LAURIER sources apply only to some students: one campus (named in the section, such as "Brantford > ..."), one faculty, or students registered with Accessible Learning (named in the source's publisher). Say who such a rule is for in the claim, and never present it as the rule for every student.

Example of the expected style (invented sources, for format only):
Sources: [1] PC141 | Announcements > Welcome: "Tutorials are held every Friday in Room B101." [2] PC141 | Announcements > Welcome > Tutorial Schedule: "PC999-T01 January 9 Friday 9:30 am – 10:20 am" [3] PC141 | Syllabus > Schedule: "Tutorials are held every second week."
Student's section: tutorial PC999-T01. Question: When is my tutorial?
{"status":"answered","pc141":[{"text":"Your first T01 tutorial is on Friday, January 9, from 9:30 am to 10:20 am.","quote":"PC999-T01 January 9 Friday 9:30 am – 10:20 am","sources":[2]},{"text":"Tutorials are held in Room B101.","quote":"Tutorials are held every Friday in Room B101.","sources":[1]},{"text":"The sources conflict on how often tutorials run: the announcement says every Friday, but the syllabus says every second week.","quote":"Tutorials are held every second week.","sources":[1,3]}],"laurier":[],"unverified":""}`;

const claimList = {
  type: "array",
  items: {
    type: "object",
    properties: { text: { type: "string" }, quote: { type: "string" }, sources: { type: "array", items: { type: "integer" } } },
    required: ["text", "quote", "sources"],
  },
};
export const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["answered", "partial", "not_found"] },
    pc141: claimList,
    laurier: claimList,
    unverified: { type: "string" },
  },
  required: ["status", "pc141", "laurier", "unverified"],
};

const pagesLabel = (pages) => (pages?.length ? `, ${pages.length > 1 ? "pp." : "p."} ${pages.join(", ")}` : "");
const AUTHORITY = { policy: "university policy", calendar: "Academic Calendar", guidance: "guidance page" };
export const sourceLabel = (s) =>
  s.kind === "pc141" ? `${s.title} > ${s.section}${pagesLabel(s.pages)}` : `${s.title} > ${s.section} (${s.publisher})`;

export function buildUserMessage(question, sources, sections) {
  const profile = [sections?.lab && `lab PC141-${sections.lab}`, sections?.tutorial && `tutorial PC141-${sections.tutorial}`].filter(Boolean);
  const blocks = sources.map(
    (s) => `[${s.n}] ${s.kind === "pc141" ? "PC141" : `LAURIER, ${AUTHORITY[s.authority] || AUTHORITY.guidance}${s.revised ? `, last revised ${s.revised}` : ""}`} | ${sourceLabel(s)}\n${s.intro ? `(Announcement opening: ${s.intro})\n` : ""}${s.text}`
  );
  return [
    profile.length ? `Student's registered sections: ${profile.join(", ")}` : "The student has not said which lab or tutorial section they are in.",
    `Sources:\n\n${blocks.join("\n\n") || "(none found)"}`,
    `Question: ${question}`,
  ].join("\n\n");
}

const NUMBER_WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, hundred: 100 };
const normalize = (s) =>
  s
    .toLowerCase()
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|hundred)\b/g, (w) => NUMBER_WORDS[w])
    .replace(/(\d),(\d{3})\b/g, "$1$2");
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

// Exact details a student could act on (emails, numbers, times) that must appear in the cited text.
function checkableFacts(text) {
  const t = normalize(text);
  const emails = t.match(EMAIL) || [];
  const numbers = t.replace(EMAIL, " ").match(/\d+(?::\d\d)?/g) || [];
  return [...new Set([...emails, ...numbers.map((n) => n.replace(/^0+(?=\d)/, ""))])];
}
function factsIn(text) {
  const t = normalize(text);
  const set = new Set(t.match(EMAIL) || []);
  for (const n of t.replace(EMAIL, " ").match(/\d+(?::\d\d)?/g) || []) {
    set.add(n.replace(/^0+(?=\d)/, ""));
    for (const part of n.split(":")) set.add(part.replace(/^0+(?=\d)/, ""));
  }
  return set;
}

// Letters and digits only, so PDF spacing quirks ("isbounding"), dashes and curly quotes don't
// stop a quote from matching its source.
const squash = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9@]+/g, "");

// True when every part of the quote ("..." separates parts) appears word for word in one of the texts.
export function quoteFound(quote, texts) {
  const parts = String(quote || "").split(/\.\.\.|…/).map(squash).filter((p) => p.length >= 8);
  const hay = texts.map(squash);
  return parts.length > 0 && parts.every((p) => hay.some((h) => h.includes(p)));
}

// Checks the model's claims against the sources they cite and decides the final status.
// Claims without a valid citation are dropped. A claim is flagged as unverified when its quote is
// not in the cited text or when it states a number, time or email the cited text does not contain.
export function verifyAnswer(raw, sources) {
  const byN = new Map(sources.map((s) => [s.n, s]));
  const out = { pc141: [], laurier: [] };
  let dropped = 0;
  for (const bucket of ["pc141", "laurier"]) {
    for (const c of Array.isArray(raw?.[bucket]) ? raw[bucket] : []) {
      const text = String(c?.text || "").replace(/(?:\s*\[\d+(?:,\s*\d+)*\])+(?=[.!?]?\s*$)/, "").trim(); // trailing [n] markers; the page shows its own
      const cited = [...new Set((Array.isArray(c?.sources) ? c.sources : []).map(Number))].filter((n) => byN.has(n));
      if (!text) continue;
      if (!cited.length) {
        dropped++;
        continue;
      }
      const kinds = new Set(cited.map((n) => byN.get(n).kind));
      const citedText = cited.map((n) => `${byN.get(n).intro || ""}\n${byN.get(n).text}`);
      const quote = String(c?.quote || "").trim();
      // A claim lives with the kind of source it cites; one citing both goes where its quote is from.
      const quoted = cited.find((n, i) => quoteFound(quote, [citedText[i]]));
      const home = kinds.size > 1 && quoted ? byN.get(quoted).kind : kinds.has(bucket) ? bucket : [...kinds][0];
      const have = factsIn(cited.map((n, i) => `${byN.get(n).title} ${byN.get(n).section} ${citedText[i]}`).join("\n"));
      const missing = checkableFacts(text).filter((f) => !have.has(f));
      const claim = { text, quote, sources: cited, verified: true };
      if (!quoted) {
        claim.verified = false;
        claim.issue = "supporting quote not found in the cited section";
      } else if (kinds.size > 1) {
        claim.verified = false;
        claim.issue = "mixes a PC141 rule with a university rule; check both sources";
      } else if (missing.length) {
        claim.verified = false;
        claim.issue = `${missing.map((m) => `"${m}"`).join(", ")} not found in the cited section`;
      }
      out[home].push(claim);
    }
  }
  const claims = [...out.pc141, ...out.laurier];
  let unverified = String(raw?.unverified || "").trim();
  if (/^(none|n\/?a|nothing|-)?\.?$/i.test(unverified)) unverified = "";
  if (dropped) unverified = [unverified, `${dropped} statement${dropped > 1 ? "s were" : " was"} removed because ${dropped > 1 ? "they" : "it"} cited no source.`].filter(Boolean).join(" ");
  let status = "answered";
  if (!claims.length) status = "not_found";
  else if (raw?.status !== "answered" || claims.some((c) => !c.verified) || unverified) status = "partial";
  if (status === "answered") unverified = "";
  if (status === "not_found" && !unverified) unverified = "The sources found do not answer this question.";
  return { status, pc141: out.pc141, laurier: out.laurier, unverified };
}

export function answerText(v) {
  const list = (cs) => cs.map((c) => `- ${c.text} ${c.sources.map((n) => `[${n}]`).join("")}${c.verified ? "" : " (unverified)"}`).join("\n");
  const parts = [];
  if (v.pc141.length) parts.push(`PC141 course rules:\n${list(v.pc141)}`);
  if (v.laurier.length) parts.push(`Laurier university-wide:\n${list(v.laurier)}`);
  if (v.unverified) parts.push(`Could not verify: ${v.unverified}`);
  return parts.join("\n\n");
}
