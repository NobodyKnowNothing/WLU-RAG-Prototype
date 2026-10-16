"""Grounded answer generation with inline citations."""
from __future__ import annotations

from typing import Any, Dict, List, Tuple

from .llm import GemmaClient
from .retriever import HybridRetriever

SYSTEM_PROMPT = (
    "You are a scholarly assistant. Answer the user's question using ONLY the provided context. "
    "You MUST cite the source document and page number inline for every factual claim you make "
    "(e.g., [Cite: PC141labRules.pdf, Page: 2]). If the answer is not in the context, state that you do not know."
)


def build_context(docs: List[Dict[str, Any]]) -> str:
    return "\n\n".join(
        f"[Source: {d['metadata']['source']}, Page: {d['metadata']['page']}]\n{d['text']}" for d in docs
    )


def answer_query(query: str, retriever: HybridRetriever, llm: GemmaClient) -> Tuple[str, List[Dict[str, Any]]]:
    docs = retriever.search(query)
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"Context:\n{build_context(docs)}\n\nQuestion: {query}"},
    ]
    answer = llm.generate(messages, temperature=0.3, max_output_tokens=1024)
    return answer, docs
