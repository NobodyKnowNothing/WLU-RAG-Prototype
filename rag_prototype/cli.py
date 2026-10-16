"""Command-line entry point.

    python -m rag_prototype index [--force]
    python -m rag_prototype ask "question" [--show-sources]
    python -m rag_prototype eval [--out results.json]
    python -m rag_prototype run          # index + demo query + eval
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from .config import PROJECT_ROOT, Settings
from .index_store import IndexStore
from .llm import GemmaClient
from .qa import answer_query
from .retriever import HybridRetriever

DEMO_QUERY = "What is the penalty for a late lab submission and can I use my phone?"
EVAL_PATH = PROJECT_ROOT / "data" / "eval_questions.json"


def make_llm(settings: Settings) -> GemmaClient:
    return GemmaClient(settings.api_key, settings.llm_model, settings.llm_fallback_model, settings.llm_thinking_level)


def cmd_index(settings: Settings, store: IndexStore, force: bool = False) -> None:
    report = store.sync(lambda: make_llm(settings), force=force)
    print(report)
    print(f"Indexed files: {len(store.manifest['docs'])}, chunks: {sum(d['n_chunks'] for d in store.manifest['docs'].values())}")


def print_answer(query: str, answer: str, docs, show_sources: bool) -> None:
    print(f"\nQ: {query}\n")
    print(answer)
    if show_sources:
        print("\nTop sources:")
        for d in docs:
            md = d["metadata"]
            print(f"  - {md['source']} p.{md['page']}  (rerank {d['rerank_score']:.2f})")


def cmd_ask(settings: Settings, store: IndexStore, query: str, show_sources: bool) -> None:
    retriever = HybridRetriever(store)
    answer, docs = answer_query(query, retriever, make_llm(settings))
    print_answer(query, answer, docs, show_sources)


def cmd_eval(settings: Settings, store: IndexStore, out: Path | None) -> None:
    retriever = HybridRetriever(store)
    llm = make_llm(settings)
    questions = json.loads(EVAL_PATH.read_text(encoding="utf-8"))

    results, hits = [], 0
    for i, q in enumerate(questions, start=1):
        answer, docs = answer_query(q["question"], retriever, llm)
        sources = [d["metadata"]["source"] for d in docs]
        hit = q["reference_file"] in sources
        hits += hit
        print(f"\n[{i}/{len(questions)}] {'HIT ' if hit else 'MISS'} {q['reference_file']}")
        print(f"Q: {q['question']}")
        print(f"Expected location: {q['answer_location']}")
        print(f"A: {answer}")
        results.append(
            {
                **q,
                "answer": answer,
                "retrieved": [{"source": d["metadata"]["source"], "page": d["metadata"]["page"], "rerank_score": d["rerank_score"]} for d in docs],
                "reference_file_retrieved": hit,
            }
        )

    print(f"\nRetrieval hit rate (reference file in top {settings.rerank_top_n}): {hits}/{len(questions)}")
    if out:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"Wrote {out}")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="rag_prototype", description="Hybrid RAG over course PDFs")
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    p_index = sub.add_parser("index", help="index new/changed files in the docs folder")
    p_index.add_argument("--force", action="store_true", help="re-process every file (cached LLM tags are still reused)")

    p_ask = sub.add_parser("ask", help="answer a question")
    p_ask.add_argument("query")
    p_ask.add_argument("--show-sources", action="store_true")

    p_eval = sub.add_parser("eval", help="run the evaluation question set")
    p_eval.add_argument("--out", type=Path, default=PROJECT_ROOT / "results" / "eval_results.json")

    p_run = sub.add_parser("run", help="full pipeline: index, demo query, eval")
    p_run.add_argument("--out", type=Path, default=PROJECT_ROOT / "results" / "eval_results.json")

    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
    for noisy in ("httpx", "google_genai", "sentence_transformers", "huggingface_hub"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    settings = Settings()
    store = IndexStore(settings)
    try:
        if args.command == "index":
            cmd_index(settings, store, force=args.force)
        elif args.command == "ask":
            cmd_ask(settings, store, args.query, args.show_sources)
        elif args.command == "eval":
            cmd_eval(settings, store, args.out)
        elif args.command == "run":
            cmd_index(settings, store)
            cmd_ask(settings, store, DEMO_QUERY, show_sources=True)
            cmd_eval(settings, store, args.out)
    finally:
        store.close()
