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

A static frontend in `docs/` is deployed to GitHub Pages by `.github/workflows/pages.yml`. It calls a Cloudflare Worker in `worker/` that runs on Workers AI (`bge-small` embeddings, `bge-reranker-base`, Llama 3.3 70B), so it does not need an API key. It answers admin questions such as "When is my lab?", "What do I do if I miss it?", "Where do I submit?" and "What are the plagiarism rules?".

- **PC141 documents (phase one).** `scripts/export_chunks.py` splits the PDFs in `files/` by section. Headings are detected from the PDF fonts: whole-line bold text, numbered headings such as "3.2 Bounding", and MyLearningSpace posts. Each chunk keeps its document title, section path and pages, so answers cite e.g. *PC141 Lab Syllabus (Fall 2026) > Requirements and Policies > Plagiarism Policy, p. 4*.
- **Official Laurier pages (phase two).** `worker/src/laurier.js` lists 16 official pages: the 2026/27 Undergraduate Academic Calendar (examinations, grades, add/drop, petitions, student regulations, fall and winter dates), students.wlu.ca pages on academic integrity, Gen AI, deferred exams, absences and petitions, policies 12.2 and 2.3, and Accessible Learning. For each question the Worker picks the relevant pages and fetches them live from wlu.ca, keeping each copy for up to 6 hours. It splits them into sections (`worker/src/html.js`) and cites the section with a link to it.
- **Course rules and university rules are kept apart.** Answers come back as two lists, *PC141 course rules* and *Laurier university-wide*. Each statement goes in the list that matches the kind of source it cites, so a university policy is never shown as a course rule.
- **Says so instead of guessing.** Each statement must give its sources and an exact supporting quote (`worker/src/answer.js`):
  - Statements with no valid source are removed.
  - Statements whose quote isn't in the cited section, or that mention a number, time or email the section doesn't contain, are marked unverified.
  - If nothing is supported, the answer is "Couldn't verify an answer".
  - When sources disagree, the answer reports both versions.
- **Two retrieval modes.** *Simple* is BM25 keyword search only. *Full* adds embeddings, fuses both with reciprocal rank fusion and reranks with the cross-encoder. Both modes add a few student-to-document synonyms to the search query (e.g. ChatGPT → "AI-based systems").

The API takes `POST {"question", "mode": "simple"|"full", "scope": "both"|"pc141"|"laurier", "sections": {"lab": "L04", "tutorial": "T02"}, "retrieveOnly": false}`. `GET /meta` lists the documents, the Laurier pages and the section codes.

### Do we need the full pipeline? (measured)

`scripts/eval_web.py` runs the questions in `data/web_eval.json` through both modes: the 19 original questions, the 4 admin questions above, 10 university-policy questions and 6 questions the sources can't answer. The results are in `results/web_eval.json` and on the site under "How it works".

| Check | Simple | Full |
|---|---|---|
| PC141 section retrieved (top 5) | 23/23 | 23/23 |
| Laurier page retrieved | 11/11 | 11/11 |
| Answer cites the right PC141 section | 4/4 | 23/23 |
| Answer cites the right Laurier page | 6/7 | 11/11 |
| Says it can't verify (unanswerable questions) | 4/4 | 6/6 |
| Statements whose quote checks out | 32/32 | 95/98 |
| Median seconds per answer | 4.9 | 7.7 |

With section-level chunks, keyword search alone found the right PC141 section as often as the full pipeline. (With 63 sections, "retrieve 150" already means reranking every section.) The reranker mattered on long Laurier policy pages. Simple's one miss was "What counts as academic misconduct at Laurier?", where it said it couldn't verify an answer rather than guessing. So starting simple works for the course documents; reranking is worth keeping for university pages. The site defaults to Full, and either mode can be picked per question.

Caveats:

- Simple-mode answers were checked on a 14-question subset (all email, unanswerable and most policy questions) to stay within the Workers AI daily allowance. Retrieval was checked on all 39 questions in both modes.
- The evaluation ran against `wrangler dev`, which uses the same models and live wlu.ca pages as the deployed Worker. The Full answers were measured before a one-sentence prompt change saying that different rules for different situations are not a conflict.
- The quote check confirms the wording exists in the source. It can't catch every overstatement, so each statement shows its quote for students to compare.
- The PC141 documents contradict each other in places. The syllabus says labs run every week, begin the week of May 4 and are in room 2089; the lab announcement says alternate weeks from September 16 in room N2089.
- Only the listed Laurier pages are searched. Questions outside them get "Couldn't verify".

```bash
.venv\Scripts\python scripts/export_chunks.py   # split files/*.pdf into worker/src/chunks.json
python scripts/embed_chunks.py                   # precompute worker/src/vectors.json (needs wrangler login)
cd worker && npm test                            # parser, retrieval and verification tests
cd worker && npx wrangler dev                    # local API on :8787 (serve docs/ on :8000 to use it)
python scripts/eval_web.py --url http://127.0.0.1:8787
cd worker && npx wrangler deploy                 # redeploy the API
```

The Worker only accepts browser requests from the Pages origin (`ALLOWED_ORIGIN` in `worker/wrangler.jsonc`) and from localhost:8000. The Python CLI still uses Gemma through the Gemini API with page-level chunks; the web demo uses different models and section-level chunks, so its answers can differ.
