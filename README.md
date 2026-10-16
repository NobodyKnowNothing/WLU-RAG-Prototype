# WLU RAG Prototype

Hybrid retrieval-augmented QA over the PC141 course PDFs in `files/`, ported from `RAG_Prototype.ipynb`.

Pipeline:

1. **Chunking**: per-page PDF text split into ~400-word chunks with 10% overlap (`rag_prototype/chunking.py`).
2. **Semantic tagging**: each chunk gets a 1–2 sentence description from Gemma (`gemma-4-31b-it`, failing over to `gemma-4-26b-a4b-it` on quota exhaustion). The description is prepended to the chunk before embedding (`rag_prototype/tagging.py`).
3. **Indexing**: dense vectors (`all-MiniLM-L6-v2`) in an on-disk Qdrant store, plus BM25 over the enriched text (`rag_prototype/index_store.py`).
4. **Retrieval**: dense + BM25 fused with Reciprocal Rank Fusion (top 150), then reranked with a cross-encoder down to the top 5 (`rag_prototype/retriever.py`).
5. **Answering**: Gemma answers using only those chunks and cites `[Cite: file, Page: n]` inline (`rag_prototype/qa.py`).

## Setup

```bash
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

Put your key in `.env`:

```
GEMINI_API_KEY=...
```

## Usage

```bash
python -m rag_prototype index                     # index new/changed files in files/
python -m rag_prototype ask "Can I use my phone in the lab?" --show-sources
python -m rag_prototype eval                      # runs data/eval_questions.json -> results/eval_results.json
python -m rag_prototype run                       # index + demo question + eval
```

## Caching and incremental indexing

Everything lives in `.rag_cache/`:

| Path | Contents |
|---|---|
| `manifest.json` | indexed files with their SHA-256 and chunk count |
| `docs/<sha>_<fp>.json` | chunks, page numbers and LLM descriptions for each file version |
| `tags.json` | LLM descriptions keyed by chunk hash. Written after every call, so an interrupted run resumes where it stopped. |
| `qdrant/` | persistent Qdrant vector store |

On each `index` run:

- **Unchanged files** (same content hash) are skipped. This makes no LLM or embedding calls.
- **New or modified files** are chunked, tagged and embedded. Vectors from the old version are deleted.
- **Deleted files** have their vectors and cached chunks removed.
- If the vector store is missing or out of sync, vectors are rebuilt from the cached chunks without calling the LLM.
- If you change the chunking, embedding model or tagging model in `config.py`, the index is rebuilt. Descriptions for chunks that did not change are still reused from `tags.json`.

`index --force` re-processes every file but still reuses cached descriptions. To start completely fresh, delete `.rag_cache/`.
