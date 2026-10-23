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

## Web demo

A static frontend in `docs/` is deployed to GitHub Pages by `.github/workflows/pages.yml`. It calls a Cloudflare Worker in `worker/` that re-implements the pipeline on Workers AI (BM25 + `bge-small` embeddings with RRF, `bge-reranker-base`, then Llama 3.3 70B for the answer), so it does not need an API key.

```bash
python scripts/export_chunks.py      # refresh worker/src/chunks.json from .rag_cache/
cd worker && npx wrangler deploy     # redeploy the API
```

The Worker only accepts requests from the Pages origin (`ALLOWED_ORIGIN` in `worker/wrangler.jsonc`). The Python CLI still uses Gemma through the Gemini API; the web demo uses different models, so its answers can differ.
