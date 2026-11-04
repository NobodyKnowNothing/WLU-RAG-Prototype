// Lexical and vector ranking helpers shared by the course-document and Laurier-page searches.

const STOPWORDS = new Set(
  "a an and are as at be by can do does for from has have how i if in is it its me my of on or our so that the their them then there these this to was we what when where which who why will with you your".split(" ")
);

// Light suffix stripping so "missed"/"missing" match "miss" and "labs" matches "lab".
export function stem(t) {
  if (t.length <= 3 || /\d/.test(t)) return t;
  let s = t;
  if (s.endsWith("ies") && s.length > 4) s = s.slice(0, -3) + "y";
  else if (s.endsWith("sses")) s = s.slice(0, -2);
  else if (/(ch|sh|x|z)es$/.test(s)) s = s.slice(0, -2);
  else if (s.endsWith("ing") && s.length > 5) s = s.slice(0, -3);
  else if (s.endsWith("ed") && s.length > 4) s = s.slice(0, -2);
  else if (s.endsWith("s") && !/(ss|us|is)$/.test(s)) s = s.slice(0, -1);
  if (s !== t && /([bdgmnprt])\1$/.test(s)) s = s.slice(0, -1); // "submitt" -> "submit"
  return s;
}

// Students' words -> the words the course documents and Laurier pages use. Appended to the search
// query only; the model still sees the original question.
const SYNONYMS = [
  [/\b(chat ?gpt|copilot|gemini|claude|gen ?ai|generative|llms?|ai)\b/i, "AI-based systems, generative AI tools"],
  [/\b(sick|ill|flu|covid|doctor)\b/i, "illness, medical documentation"],
  [/\b(miss|missed|missing|skip|skipped|absent|absence)\b/i, "absence, attendance, make-up"],
  [/\b(phones?|laptops?|tablets?|devices?|smart ?watch)\b/i, "digital devices"],
  [/\b(cheat|cheating|copy|copied|copying)\b/i, "plagiarism, academic misconduct"],
  [/\b(hand in|turn in|upload|submit|submission)\b/i, "submit, Dropbox, MyLearningSpace"],
  [/\blate\b/i, "late submission deduction"],
  [/\b(marks?|marking|graded)\b/i, "grade, grading"],
  [/\b(prof|professor|teacher|ta|contact)\b/i, "instructor, IA, email"],
];

export function expandQuery(q) {
  const extra = SYNONYMS.filter(([re]) => re.test(q)).map(([, words]) => words);
  return extra.length ? `${q} (${extra.join("; ")})` : q;
}

export const tokenize = (s) => (s.toLowerCase().match(/\w+/g) || []).filter((t) => !STOPWORDS.has(t)).map(stem);

// Okapi BM25 over a fixed list of texts.
export class BM25 {
  constructor(texts, k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
    this.docs = texts.map((t) => {
      const tf = new Map();
      const toks = tokenize(t);
      for (const w of toks) tf.set(w, (tf.get(w) || 0) + 1);
      return { tf, len: toks.length };
    });
    this.avgLen = this.docs.reduce((n, d) => n + d.len, 0) / (this.docs.length || 1);
    this.df = new Map();
    for (const d of this.docs) for (const w of d.tf.keys()) this.df.set(w, (this.df.get(w) || 0) + 1);
  }

  scores(query) {
    const q = [...new Set(tokenize(query))];
    const N = this.docs.length;
    return this.docs.map((d) => {
      let score = 0;
      for (const w of q) {
        const f = d.tf.get(w);
        if (!f) continue;
        const n = this.df.get(w);
        const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1);
        score += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / this.avgLen));
      }
      return score;
    });
  }

  // [[index, score], ...] best first, only documents sharing a term with the query.
  rank(query, k = Infinity) {
    return this.scores(query)
      .map((s, i) => [i, s])
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, k);
  }
}

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
export const cosine = (a, b) => dot(a, b) / (Math.sqrt(dot(a, a)) * Math.sqrt(dot(b, b)));

// Reciprocal rank fusion of several ranked lists of [index, score]; returns indices best first.
export function rrf(lists, k = 60) {
  const fused = new Map();
  for (const ranked of lists) ranked.forEach(([i], rank) => fused.set(i, (fused.get(i) || 0) + 1 / (k + rank + 1)));
  return [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i);
}
