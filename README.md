# PC141 Course Assistant (WLU RAG Prototype)

A question-answering assistant for students in **PC141 at Wilfrid Laurier University**. It answers administrative questions, such as "When is my lab?", "What do I do if I miss it?", "Where do I submit?" or "What is the penalty for a first plagiarism offence?". Every statement in an answer cites the section it came from, quotes it, and is checked against that quote.

- **Site:** <https://nobodyknownothing.github.io/WLU-RAG-Prototype/>
- **API:** `https://wlu-rag-api.nobodyknownothing.workers.dev`

The project started as a Python RAG notebook over four course PDFs. It is now three things:

1. **A deployed web assistant.** A static page on GitHub Pages calls a Cloudflare Worker. The Worker answers from the PC141 documents and from official Laurier sources, and keeps the two apart.
2. **A Laurier policy index.** Every university policy and procedure, plus key Academic Calendar and student pages (183 pages, 2,390 sections), is kept in D1 + Vectorize and re-checked against wlu.ca every week. The Worker uses it for answers, and agents can search it over MCP or HTTP.
3. **The original Python prototype.** It still works as a command-line tool (Gemma via the Gemini API, Qdrant, BM25), but the web assistant no longer uses it.

## Repository layout

| Path | What it is |
|---|---|
| [`docs/`](docs/) | The frontend: a single `index.html`, deployed to GitHub Pages by `.github/workflows/pages.yml` |
| [`worker/`](worker/) | The Cloudflare Worker API (`wlu-rag-api`): retrieval, Laurier sources, answer generation and verification, answer cache, MCP endpoint |
| [`policy_index/`](policy_index/) | The Laurier policy index: crawler, section chunker, weekly sync, hybrid search, MCP/HTTP server. See [its README](policy_index/README.md) and [HOSTING.md](policy_index/HOSTING.md) |
| [`scripts/`](scripts/) | Build and evaluation scripts for the Worker (chunk export, embeddings, policy list, eval runner, AI-allowance probe) |
| [`rag_prototype/`](rag_prototype/) | The original Python RAG CLI |
| [`files/`](files/) | The PC141 source PDFs: lab syllabus, lab manual, lab rules, tutorial rules |
| [`data/`](data/) | Evaluation questions: `eval_questions.json` (19, Python CLI) and `web_eval.json` (48, web assistant) |
| [`results/`](results/) | Recorded evaluation runs |
| `.rag_cache/` | The Python prototype's committed index, so a fresh clone can answer without re-tagging |

## How an answer is produced

```
question ──► retrieve PC141 sections ──┐
         └─► retrieve Laurier sources ─┴─► LLM writes JSON answer ──► verifier ──► two cited lists
              policy index (D1 + Vectorize)        Workers AI or Groq     quotes,      "PC141 course rules"
              + live wlu.ca site search            (Llama 3.3 / GPT-OSS)  numbers,     "Laurier university-wide"
                                                                          emails
```

### Sources

- **PC141 documents.** `scripts/export_chunks.py` splits the PDFs in `files/` by section into `worker/src/chunks.json` (63 sections). Headings are detected from PDF fonts: whole-line bold text, numbered headings like "3.2 Bounding", and MyLearningSpace posts. Citations read like *PC141 Lab Syllabus (Fall 2026) > Requirements and Policies > Plagiarism Policy, p. 4*. Students can pick their lab and tutorial section (e.g. L04, T02), so answers about times and rooms use their section.
- **Laurier policy index.** The 167 governance pages listed in the wlu.ca sitemap, plus 16 hand-picked pages (2026/27 Undergraduate Academic Calendar sections and dates; students.wlu.ca pages on academic integrity, Gen AI, deferred exams, absences, petitions and Accessible Learning). They are split into sections, with long sections split by clause, so a citation can point to *12.2 Student Code of Conduct: Academic Misconduct > 4.04 Penalties for Academic Misconduct, 4.04.01* and link straight to it.
- **Laurier site search.** For anything outside the index, such as transcripts, parking or the OneCard, the Worker queries the endpoint behind wlu.ca's search box and fetches the pages live, caching each for 6 hours. It isn't a published API, so the Worker sends one request per question; set `SITE_SEARCH` to `"off"` in `worker/wrangler.jsonc` to disable it. News posts are skipped. PDF, Word and Qualtrics forms are listed as links when the question asks for a form, but are not quoted.

Each Laurier source is labelled as a *university policy* (with its revision date), the *Academic Calendar* or a *guidance page*. When they disagree, the policy or calendar comes first. Campus tabs (Waterloo, Brantford, Kitchener, Milton) stay in the section name, and the model must say when a rule only covers one campus, faculty or group of students.

### Retrieval modes

- **Simple:** BM25 keyword search only.
- **Full** (the default): keyword search plus `bge-small-en-v1.5` embeddings, fused with reciprocal rank fusion and reranked with `bge-reranker-base`.

Both modes add a few student-to-document synonyms (e.g. ChatGPT → "AI-based systems"), ignore "Laurier"/"WLU"/"Wilfrid" as search terms, and also search for definitions when a question asks what something "counts as" or "means".

### Answers and verification

The model returns JSON with two lists, *PC141 course rules* and *Laurier university-wide*. Each statement goes in the list that matches the source it cites, so a university policy is never presented as a course rule. Then `worker/src/answer.js` checks every statement:

- Statements with no valid source are removed.
- Statements whose quote isn't in the cited section, or that mention a number, time or email the section doesn't contain, are marked **unverified**.
- If nothing is supported, the answer is "Couldn't verify an answer".
- When sources disagree, both versions are reported.

The quote check confirms the wording exists in the source. It can't catch every overstatement, so the page shows each statement's quote for students to compare.

### Models, daily limits and caching

Everything runs on free tiers, and the binding limit is the **Workers AI daily allowance** (10,000 neurons, shared by every model and every user). Llama 3.3 70B spends about 120 neurons per answer; an embedding or rerank costs a fraction of one. In practice the allowance has run out after 40 to 50 answers, and not always at the documented 00:00 UTC reset.

So the Worker (`worker/src/llm.js`) splits the work:

- **Workers AI** (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) writes the first `WORKERS_AI_DAILY_ANSWERS` answers of each UTC day (default 25, counted in the D1 table `ai_usage`).
- **Groq** (`openai/gpt-oss-120b`, or the `GROQ_MODEL` var) writes the rest, which leaves the remaining allowance for embeddings and reranking. Groq's `llama-3.3-70b-versatile` is no longer open to regular accounts (its limits say "Contact Sales", and requests get 404 `model_not_found`). GPT-OSS is a reasoning model, so it runs with `reasoning_effort: "low"` and a 4,096-token allowance. On the live Worker it answered in about 1.7 s. How many answers a day Groq covers depends on its free-tier token limits.
- Each provider backs up the other: Workers AI answers when Groq is rate-limited, and Workers AI error 4006 sends the answer to Groq. Full mode never quietly drops to keyword-only retrieval. If Workers AI is out entirely, the Worker returns 429 and the page asks students to try again later.
- GPT-OSS on Groq gets the answer schema as a strict structured output; a `GROQ_MODEL` without strict support gets JSON mode with the schema in the prompt. The verifier checks the result as usual. Quotes are checked sentence by sentence, so a quote that skips a list number between two sentences, or gives them in another order, still matches, while every sentence must be verbatim. Each response's `llm` field names the provider (`budgetReached: true` when the budget sent it to Groq).

**Answer cache** (`worker/src/cache.js`): answers are kept for 24 hours in the D1 table `answer_cache`, with a small in-memory copy per isolate. The key is the normalised question (case, spacing and trailing punctuation ignored), mode, scope and sections. A repeat question costs no model calls, and identical questions asked at the same moment share one answer. Answers built while a Laurier page was unavailable are kept for only 2 hours. Bump `CACHE_VERSION` when retrieval or the prompt changes.

## API

`POST /` with a JSON body:

```json
{
  "question": "What do I do if I miss my lab?",
  "mode": "full",
  "scope": "both",
  "sections": { "lab": "L04", "tutorial": "T02" },
  "retrieveOnly": false,
  "cache": true
}
```

- `mode`: `"simple"` or `"full"` (default).
- `scope`: `"both"` (default), `"pc141"` or `"laurier"`.
- `retrieveOnly: true` returns the retrieved sources without calling the LLM. These requests are never cached.
- `cache: false` skips the cached answer; a fresh one is still stored.
- Cached responses carry `cached: true` and `cachedAt`.

Other routes:

- `GET /meta`: the PC141 documents, Laurier catalog, policy-index stats and valid section codes.
- `POST /mcp`: MCP (stateless Streamable HTTP) with the tools `search_policies`, `get_policy_section` and `list_policies`.
- `POST /policy-search {"query", "k", "kinds"}`: plain HTTP search of the policy index.

The policy-index routes make no LLM calls, and fall back to keyword search when the AI allowance is used up. Browser requests are only accepted from `ALLOWED_ORIGIN` (the Pages site) and `localhost:8000`.

To use the policy index from Claude Code:

```bash
claude mcp add --transport http wlu-policies https://wlu-rag-api.nobodyknownothing.workers.dev/mcp
```

## Results

All 48 questions are in `data/web_eval.json`: the 19 original questions, 4 admin questions, 10 on the hand-picked Laurier pages, 6 on other policies, 4 that only site search can reach, and 5 the sources can't answer. Full results are in `results/web_eval.json` and on the site under "How it works".

| Check | Simple | Full |
|---|---|---|
| PC141 section retrieved (top 5) | 23/23 | 23/23 |
| Laurier page retrieved | 21/21 | 21/21 |
| Answer cites the right PC141 section | 4/4 | 23/23 |
| Answer cites the right Laurier page | 6/7 | 20/21 |
| Says it can't verify (unanswerable questions) | 4/4 | 5/5 |
| Median seconds per answer | 4.9 | ~10 |

Retrieval rows are from the live Worker with the policy index (2026-11-06). The Full answer rows combine the 2026-11-05 run on the PC141 questions with the 2026-11-06 re-run of the 21 university-side questions on the index. The Simple answer rows are from an earlier 14-question run, before the index and site search. In the Full runs, 117 of 119 statement quotes checked out on 2026-11-05 and 65 of 67 on the university side on 2026-11-06; the failures were marked unverified.

What this showed:

- **Keyword search is enough for the course documents.** With 63 section-level chunks, BM25 found the right PC141 section as often as the full pipeline.
- **Ranking matters for university pages.** On long policy pages, Simple's one miss was "What counts as academic misconduct at Laurier?". It said it couldn't verify an answer rather than guessing.
- **For the policy index alone, hybrid search beat reranking.** On the 17 questions whose pages are in the index, hybrid keyword + vector search ranked the expected page first 17/17 times (MRR 1.00), keyword only 15/17, and adding the local reranker 14/17. Details are in [policy_index/README.md](policy_index/README.md).

The evaluation runs led to concrete fixes, all recorded in the commit history. Campus tabs are now kept apart, site-search pages are labelled with their part of the site, "Laurier" is ignored as a search term, the verifier no longer reads "one's own" as the number 1, and dated news posts are no longer used as sources.

## Running it

### Web assistant (Worker + page)

Requires Node 22.13+ and a Cloudflare account (`npx wrangler login`).

```bash
cd worker && npm test                     # parser, retrieval, verification, LLM-routing and cache tests
cd worker && npx wrangler dev             # local API on :8787, using the real D1 database and Vectorize index
python -m http.server 8000 -d docs        # the page; on localhost it calls the local API
cd worker && npx wrangler deploy          # deploy the API
```

Configuration (`worker/wrangler.jsonc` and secrets):

| Setting | Purpose |
|---|---|
| `POLICY_DB`, `POLICY_INDEX` | D1 database and Vectorize index `wlu-policies`. Remove both to fall back to fetching catalog pages live |
| `ALLOWED_ORIGIN` | The frontend origin allowed to call the API |
| `SITE_SEARCH` | `"on"` / `"off"` for wlu.ca site search |
| `GROQ_API_KEY` (secret) | Enables Groq answers: `npx wrangler secret put GROQ_API_KEY`. Stray BOMs and line breaks from a Windows shell are stripped |
| `GROQ_MODEL`, `WORKERS_AI_DAILY_ANSWERS` | Groq model and the daily Workers AI answer budget (default 25) |

The frontend deploys automatically when `docs/` changes on `main`.

### Rebuilding data and evaluating

```bash
python scripts/export_chunks.py               # files/*.pdf → worker/src/chunks.json
python scripts/embed_chunks.py                # worker/src/vectors.json (needs wrangler login)
node scripts/build_policy_index.mjs           # refresh worker/src/policies.json from the wlu.ca sitemap
python scripts/eval_web.py --url http://127.0.0.1:8787
python scripts/eval_web.py --modes full --ids S3,U1 --merge   # re-run some questions, keep the rest
python scripts/ai_budget.py                   # check cheaply whether the Workers AI allowance is back
```

`eval_web.py` skips the answer cache unless given `--use-cache`. A full 48-question answer run can use the whole daily allowance, so split runs with `--ids` and `--merge`.

### Policy index

```bash
cd policy_index && npm install
node src/cli.mjs sync                # build/update a local SQLite index (~5 min the first time)
node src/cli.mjs search "What is the penalty for a first plagiarism offence?"
node src/cli.mjs serve               # HTTP + MCP on http://127.0.0.1:8790
node src/cli.mjs sync --store cloudflare   # update the deployed D1 + Vectorize index
```

`.github/workflows/policy-index.yml` runs the sync every Monday. It re-embeds only sections whose text changed, deletes removed sections and pages, and refuses to delete more than 20% of pages in one run unless forced. It needs the secrets `CLOUDFLARE_ACCOUNT_ID` and `POLICY_INDEX_API_TOKEN` and the variable `D1_DATABASE_ID`; without them it maintains a SQLite index as a build artifact instead. See [policy_index/README.md](policy_index/README.md) for setup, design and measurements.

### Original Python prototype

Requires Python 3.10+ (tested on 3.12) and a Gemini API key in `.env` (`GEMINI_API_KEY=...`).

```bash
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt     # .venv/bin/pip on macOS/Linux
python -m rag_prototype ask "Can I use my phone in the lab?" --show-sources
python -m rag_prototype index                     # index new/changed PDFs in files/
python -m rag_prototype eval                      # writes results/eval_results.json
python -m rag_prototype run                       # index + demo question + eval
```

It chunks each PDF page, has Gemma (`gemma-4-31b-it`, with `gemma-4-26b-a4b-it` as fallback) write a description of each chunk, indexes the chunks with MiniLM embeddings in Qdrant plus BM25, fuses and reranks them with a cross-encoder, and answers from the top 5 with `[Cite: file, Page: n]`. It found the correct PDF in the top 5 for 19/19 questions.

Indexing is incremental. PDFs are identified by SHA-256, Gemma's descriptions are saved after each call so an interrupted run resumes, and the committed `.rag_cache/` lets a fresh clone answer straight away. Delete `.rag_cache/` to rebuild from scratch. Its page numbers are PDF positions, not printed page numbers. Because it uses different models and page-level chunks, its answers can differ from the web assistant's.

## Known limitations

- **Daily capacity.** On free tiers, expect a few dozen fresh answers a day across all users (Workers AI plus Groq); cached repeats are free. Workers Paid removes the Workers AI cap at $0.011 per 1,000 neurons.
- **The PC141 documents contradict each other.** The syllabus says labs run weekly from the week of May 4 in room 2089. The lab announcement says alternate weeks from September 16 in room N2089. The assistant reports both.
- **Sign-in pages are out of reach.** Laurier Connect, MyLearningSpace and the contents of PDF and Word forms can't be read, so questions that need them get "Couldn't verify".
- **Some questions have no public answer.** For example, no public page says how a student gets a Waterloo parking permit, so the assistant correctly says it can't verify one.
- **Short PC141 embeddings are slightly off.** Workers AI pads batched embeddings, so the short chunks in `worker/src/vectors.json`, embedded in batches of 8, are at cosine 0.92–0.97 from their true vectors. Re-embedding one chunk per call would fix this. The policy index already embeds that way.
- **Some things haven't been run.** The policy index's Docker image and the scheduled GitHub Actions sync have not been tested.
