# WLU RAG Prototype

Question answering with citations over the PC141 course PDFs in `files/`.

**Pipeline:**

1. Split each PDF page into chunks.
2. Gemma (`gemma-4-31b-it`, with `gemma-4-26b-a4b-it` as fallback) writes a short description of each chunk.
3. Index the chunks for search: embeddings (MiniLM) in Qdrant, plus BM25 keyword search.
4. Merge both result lists with reciprocal rank fusion (RRF), then rerank them with a cross-encoder and keep the top 5.
5. Gemma answers from those 5 chunks and cites them as `[Cite: file, Page: n]`.

## Setup

Requires Python 3.10+ (tested on 3.12).

```bash
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

On macOS/Linux, use `.venv/bin/pip` instead. Then create a `.env` file containing your Gemini API key:

```
GEMINI_API_KEY=your-key
```

## Usage

```bash
python -m rag_prototype run                                  # index + demo question + eval
python -m rag_prototype index                                # index new/changed PDFs in files/
python -m rag_prototype ask "Can I use my phone in the lab?" --show-sources
python -m rag_prototype eval                                 # writes results/eval_results.json
```

## Caching

The index is committed in `.rag_cache/`, so a fresh clone can answer questions straight away without re-tagging the PDFs:

- Each PDF is identified by its SHA-256 hash. Unchanged PDFs are skipped, edited ones are re-processed, and deleted ones are removed from the index.
- Gemma descriptions are saved after every call (`tags.json`), so an interrupted index run resumes where it stopped.
- If the vector store is lost, it is rebuilt from the cached chunks without calling Gemma.
- Changing the chunking, embedding model, Gemma model or tagging prompt in `rag_prototype/config.py` triggers a full rebuild. Cached descriptions are still reused where possible.

To rebuild from scratch, delete `.rag_cache/`.

## Results

These are from indexing 4 PDFs (36 pages) into 36 chunks. Results are in `results/eval_results.json`.

| Metric | Result |
|---|---|
| Correct PDF in the top 5 results | **19/19** questions |
| First index run, from empty cache | ~5 min |
| Re-index with no changes | ~3 s, no Gemma calls |

Every answer cites its source, and the 19 answers agree with the expected answer locations. Two answers (Q10, Q14) also mention the matching lab or tutorial rule from the other PDF.

**Caveats:**

- Cited page numbers are PDF page positions, not the numbers printed on the page. For example, "Page 2" in the printed lab manual is PDF page 6.
- Gemma 4 calls take 20–70 s each and sometimes fail with 500/503 errors. The client fails over to the other model and retries.
- Gemma's thinking is set to minimal. With the default setting, its hidden reasoning used up the reply's token limit and answers came back empty or cut off.

## Web demo: PC141 admin assistant

A static frontend in `docs/` is deployed to GitHub Pages by `.github/workflows/pages.yml`. It calls a Cloudflare Worker in `worker/` that runs on Workers AI (`bge-small` embeddings, `bge-reranker-base`, Llama 3.3 70B), with Llama 3.3 70B on Groq as a backup (below). It answers admin questions such as "When is my lab?", "What do I do if I miss it?", "Where do I submit?" and "What are the plagiarism rules?".

- **PC141 documents (phase one).** `scripts/export_chunks.py` splits the PDFs in `files/` by section. Headings are detected from the PDF fonts: whole-line bold text, numbered headings such as "3.2 Bounding", and MyLearningSpace posts. Each chunk keeps its document title, section path and pages, so answers cite e.g. *PC141 Lab Syllabus (Fall 2026) > Requirements and Policies > Plagiarism Policy, p. 4*.
- **Official Laurier pages (phase two).** University-wide answers come from three places (`worker/src/laurier.js`). The first two are now read from the policy index (see below): every section of those pages is kept in D1 and Vectorize and re-checked against wlu.ca weekly. Site search results are still fetched live and kept for up to 6 hours. Before the index, all three were fetched live:
  - 16 hand-picked student pages: the 2026/27 Undergraduate Academic Calendar (examinations, grades, add/drop, petitions, student regulations, fall and winter dates) and students.wlu.ca pages on academic integrity, Gen AI, deferred exams, absences, petitions and Accessible Learning.
  - Every university policy and procedure, 169 in all, listed in `worker/src/policies.json`. `scripts/build_policy_index.mjs` builds that list from the wlu.ca sitemap, which lists the whole policy register under `/about/governance/assets/resources/`. It records each policy's title, number, approval and revision dates, office and purpose, and re-reads only pages whose sitemap date changed.
  - Laurier's own site search (the endpoint behind wlu.ca's search box) for any other public page, such as transcripts, parking or the OneCard. It is not a published API, so the Worker sends one request per question and caches results; setting `SITE_SEARCH` to `"off"` in `wrangler.jsonc` turns it off. PDFs, Word files and Qualtrics forms it finds are listed as links when the question asks for a form, but not quoted.

  The Worker splits pages into sections (`worker/src/html.js`) and cites the section with a link to it. Campus tabs (Waterloo, Brantford, Kitchener, Milton) stay in the section name, so a Brantford rule is cited as *Brantford > …*. Pages found by site search are labelled with their part of the site (e.g. *Laurier Students: Accessible Learning*), and the model must say when a rule only covers one campus, faculty or group of students. Each source is marked as a *university policy* (with its last revision date), the *Academic Calendar* or a *guidance page*. When they disagree, the policy or calendar version comes first.
- **Course rules and university rules are kept apart.** Answers come back as two lists, *PC141 course rules* and *Laurier university-wide*. Each statement goes in the list that matches the kind of source it cites, so a university policy is never shown as a course rule.
- **Says so instead of guessing.** Each statement must give its sources and an exact supporting quote (`worker/src/answer.js`):
  - Statements with no valid source are removed.
  - Statements whose quote isn't in the cited section, or that mention a number, time or email the section doesn't contain, are marked unverified.
  - If nothing is supported, the answer is "Couldn't verify an answer".
  - When sources disagree, the answer reports both versions.
- **Two retrieval modes.** *Simple* is BM25 keyword search only. *Full* adds embeddings, fuses both with reciprocal rank fusion and reranks with the cross-encoder. Both modes add a few student-to-document synonyms to the search query (e.g. ChatGPT → "AI-based systems").

The API takes `POST {"question", "mode": "simple"|"full", "scope": "both"|"pc141"|"laurier", "sections": {"lab": "L04", "tutorial": "T02"}, "retrieveOnly": false}`. `GET /meta` lists the documents, the Laurier pages and the section codes.

### Do we need the full pipeline? (measured)

`scripts/eval_web.py` runs the questions in `data/web_eval.json` through both modes:
- the 19 original questions and the 4 admin questions above;
- 10 questions on the hand-picked Laurier pages;
- 6 on other university policies (12.3, 12.5, 9.3, 10.2, 2.5, 12.4), and 4 that only the site search can reach (transcripts, parking, OneCard, the Dean of Science);
- 5 questions the sources can't answer.

The results are in `results/web_eval.json` and on the site under "How it works".

| Check | Simple | Full |
|---|---|---|
| PC141 section retrieved (top 5) | 23/23 | 23/23 |
| Laurier page retrieved | 21/21 | 20/20 |
| Answer cites the right PC141 section | 4/4 | 23/23 |
| Answer cites the right Laurier page | 6/7 | 19/20 |
| Says it can't verify (unanswerable questions) | 4/4 | 5/5 |
| Statements whose quote checks out | 32/32 | 117/119 |
| Median seconds per answer | 4.9 | 10.3 |

The Full answer rows are from 2026-11-05 on `wrangler dev`, with the fixes listed below (not yet deployed). That run used the same models and live wlu.ca pages as the deployed Worker, and covered 47 of the 48 questions. The Dean of Science question hit the Workers AI daily allowance. The Simple answer rows are from an earlier 14-question run, before the policy index and site search. The retrieval rows cover every question in Simple mode, and the PC141 and university-side questions in Full mode.

With section-level chunks, keyword search alone found the right PC141 section as often as the full pipeline. (With 63 sections, "retrieve 150" already means reranking every section.) The reranker mattered on long Laurier policy pages. Simple's one miss was "What counts as academic misconduct at Laurier?", where it said it couldn't verify an answer rather than guessing. So starting simple works for the course documents; reranking is worth keeping for university pages. The site defaults to Full, and either mode can be picked per question.

An earlier Full run against the deployed Worker, the same day, covered 41 questions. It got three wrong, and each has a fix:

- *How do I request a deferred final exam?* cited the Accessible Learning Centre's exam-booking page, which site search found, and gave its steps (the ALC Deferred Exam Form) as if they applied to every student.
  - Fix: pages found by site search now carry their part of the site in the source label, and the prompt asks the model to say who a rule is for.
  - Re-run: the answer now gives the general deadlines first and says the ALC steps are for students registered with Accessible Learning.
- *What counts as academic misconduct at Laurier?* was only partly verified. Every section of Policy 12.2 says "academic misconduct", so keyword ranking picked its Purpose section (which says "Laurier") over its definitions.
  - Fix: "Laurier", "WLU" and "Wilfrid" are now ignored in searches, and "counts as" / "means" / "considered" also search for definitions. This also stops the lab manual's "parking spaces at Laurier" example from turning up as a PC141 source for university questions.
  - Re-run: fully verified.
- *How do I get a parking permit on the Waterloo campus?* said it couldn't verify an answer. The parking page puts each campus in a tab, and the parser didn't keep the tabs apart, so Brantford's text appeared under a Waterloo heading.
  - Fix: the campus is now part of each section's name.
  - Re-run: still "couldn't verify", which is correct. No public page found says how a student gets a Waterloo permit. The student page's Waterloo tab only says permits are required, and wlu.ca's Waterloo parking page is for visitors.

Other changes after that run:

- The verifier read "one's own" as the number 1 and rejected an exact quote. It no longer does.
- The first-offence penalty question was re-scored as correct. It cites section 5.0 of the official *Procedures for Student Code of Conduct*, which the expected pages didn't list.
- "Who is the Dean of Science?" moved from the unanswerable group to site search. Site search now finds the answer on wlu.ca.

Two of the 119 statements in the Full run had quotes that didn't check out, and both were marked unverified:
- **L6:** the model fixed a typo in the source ("occassional") while quoting it.
- **L9:** the model claimed two deadlines conflict without giving a quote, although they cover different situations.

Caveats:

- **Daily capacity.** The Workers AI free plan gives the account 10,000 neurons a day, shared by every user and by evaluation runs. Cloudflare's usage analytics count about 120 neurons per answer, nearly all of it Llama 3.3 70B. In practice, though, the allowance ran out at about 15:15 UTC on 2026-11-05 after 41 answers, when the analytics showed only about 5,100 neurons. It was back by 21:10 UTC, ran out again after 49 more answers, and on 2026-11-04 it ran out near 10,000. So neither the dashboard nor the documented 00:00 UTC reset is a reliable guide. Expect roughly 40 to 50 answers at a time across all users on the free plan. After that the Worker returns 429, and the page asks students to try again in a few hours. Workers Paid removes the cap and charges $0.011 per 1,000 neurons above the free allowance. A full 48-question answer run can use the whole allowance, so split evaluations with `--ids` and `--merge`.
- **Groq for answers, Workers AI kept for retrieval.** With the `GROQ_API_KEY` secret set (`npx wrangler secret put GROQ_API_KEY`), answers can also be written by `llama-3.3-70b-versatile` on Groq (`worker/src/llm.js`; the `GROQ_MODEL` var picks another Groq model). The Workers AI allowance is shared by every model, and Llama spends about 120 neurons an answer against a fraction of a neuron for a retrieval. Once Llama had used it up, the query embedding failed too and Full mode was left with keyword search. So Workers AI now writes only the first `WORKERS_AI_DAILY_ANSWERS` answers of each UTC day (default 25, counted in the D1 table `ai_usage`), and Groq writes the rest. The rest of the allowance then keeps vector search and the reranker running. Each provider backs up the other: past the budget, Workers AI still answers when Groq is rate-limited, and error 4006 from Workers AI sends the answer to Groq. Full mode never falls back to keyword-only retrieval. If Workers AI is out anyway, the Worker returns 429 and the page asks students to try again later. Groq's Llama 3.3 has JSON mode but no schema-constrained output, so the schema is written into its prompt and `verifyAnswer` checks the result as usual. Each response's `llm` field names the provider (`budgetReached: true` when the budget sent it to Groq). Groq's free tier allows about 100,000 tokens a day for this model, roughly 20 to 30 answers.
- **Answer cache.** Answers are cached for 24 hours (`worker/src/cache.js`), keyed on the question (ignoring case, spacing and trailing punctuation), mode, scope and sections. Repeats cost no embedding, rerank or LLM calls. The cache is a table `answer_cache` in the `wlu-policies` D1 database, created on first use, with a small in-memory copy per isolate; identical questions asked at the same moment also share one answer. Answers with a Laurier page unavailable are kept for 2 hours, so a complete answer replaces them. Cached responses carry `cached: true` and `cachedAt`. Send `"cache": false` to skip the cached answer (`scripts/eval_web.py` does this unless given `--use-cache`), and bump `CACHE_VERSION` when retrieval or the prompt changes. `retrieveOnly` requests are never cached.
- After deploying, all 48 questions were re-run against the live Worker in Simple retrieval mode: 122 wlu.ca page loads, 53 of them found through site search, with no errors. Two answers were also checked end to end on the live site: the L04 lab time and ordering a transcript.
- The quote check confirms the wording exists in the source. It can't catch every overstatement, so each statement shows its quote for students to compare.
- The PC141 documents contradict each other in places. The syllabus says labs run every week, begin the week of May 4 and are in room 2089; the lab announcement says alternate weeks from September 16 in room N2089.
- Pages behind a Laurier sign-in (Laurier Connect, MyLearningSpace) and the contents of PDF and Word forms are out of reach. Questions that need them get "Couldn't verify".

```bash
.venv\Scripts\python scripts/export_chunks.py   # split files/*.pdf into worker/src/chunks.json
python scripts/embed_chunks.py                   # precompute worker/src/vectors.json (needs wrangler login)
node scripts/build_policy_index.mjs              # refresh worker/src/policies.json from the wlu.ca sitemap
cd worker && npm test                            # parser, retrieval and verification tests
cd worker && npx wrangler dev                    # local API on :8787 (serve docs/ on :8000 to use it)
python scripts/eval_web.py --url http://127.0.0.1:8787
python scripts/eval_web.py --modes full --ids S3,U1 --merge   # re-run some questions against the live Worker, keep the rest
cd worker && npx wrangler deploy                 # redeploy the API
```

The Worker only accepts browser requests from the Pages origin (`ALLOWED_ORIGIN` in `worker/wrangler.jsonc`) and from localhost:8000. The Python CLI still uses Gemma through the Gemini API with page-level chunks; the web demo uses different models and section-level chunks, so its answers can differ.

## Policy index: every Laurier policy, by section

`policy_index/` is a vector index of all 183 Laurier policy, procedure, Academic Calendar and student pages, split into 2,390 citable sections. A weekly job (`.github/workflows/policy-index.yml`) re-checks wlu.ca and re-embeds only the sections that changed.

Since 2026-11-06 the deployed Worker reads those pages from the index: its D1 database `wlu-policies` (rows and FTS5 keyword index) and Vectorize index `wlu-policies` are bound as `POLICY_DB` and `POLICY_INDEX` in `worker/wrangler.jsonc`. Simple mode searches the index by keyword, and Full mode adds vector search. Site search still covers pages outside the index, and if the index fails the Worker falls back to fetching pages live. The same Worker serves the index to agents, with no LLM calls:
- `POST /mcp`: MCP tools `search_policies`, `get_policy_section` and `list_policies`;
- `POST /policy-search {"query"}`.

When the Workers AI allowance is used up, both still answer from keyword search. `python scripts/ai_budget.py` uses that to check, for a fraction of a neuron, whether the allowance is back. Each result cites one section (*12.2 Student Code of Conduct: Academic Misconduct > 4.04 Penalties for Academic Misconduct, 4.04.01*) with a link that scrolls to it. See [policy_index/README.md](policy_index/README.md) for the design and measurements, and [policy_index/HOSTING.md](policy_index/HOSTING.md) for the comparison of free vector-database hosts.
