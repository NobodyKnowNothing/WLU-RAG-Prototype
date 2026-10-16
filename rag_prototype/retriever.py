"""Hybrid (dense + BM25) retrieval with Reciprocal Rank Fusion and
cross-encoder reranking."""
from __future__ import annotations

import re
from functools import cached_property
from typing import Any, Dict, List

import numpy as np
from rank_bm25 import BM25Okapi

from .index_store import IndexStore

_TOKEN_RE = re.compile(r"\w+")


def tokenize(text: str) -> List[str]:
    return _TOKEN_RE.findall(text.lower())


class HybridRetriever:
    def __init__(self, store: IndexStore):
        self.store = store
        self.settings = store.settings
        self.chunks = store.all_chunks()
        if not self.chunks:
            raise RuntimeError("Index is empty; run `python -m rag_prototype index` first")
        # BM25 is cheap to rebuild from the cached chunks on every start.
        self.bm25 = BM25Okapi([tokenize(c["enriched_text"]) for c in self.chunks])

    @cached_property
    def cross_encoder(self):
        from sentence_transformers import CrossEncoder

        return CrossEncoder(self.settings.reranker_model)

    def retrieve(self, query: str, top_k: int | None = None) -> List[Dict[str, Any]]:
        top_k = top_k or self.settings.retrieve_top_k

        # Dense search
        query_vector = self.store.embedder.encode(query, normalize_embeddings=True).tolist()
        dense_hits = self.store.qdrant.query_points(
            collection_name=self.settings.collection_name, query=query_vector, limit=top_k
        ).points
        dense_ranked = {str(hit.id): (rank, hit.payload) for rank, hit in enumerate(dense_hits)}

        # Sparse (BM25) search
        scores = self.bm25.get_scores(tokenize(query))
        top_idx = [i for i in np.argsort(scores)[::-1][:top_k] if scores[i] > 0]
        bm25_ranked = {
            self.chunks[i]["id"]: (rank, {"text": self.chunks[i]["text"], "metadata": self.chunks[i]["metadata"]})
            for rank, i in enumerate(top_idx)
        }

        # Reciprocal Rank Fusion
        k = self.settings.rrf_k
        fused = []
        for doc_id in dense_ranked.keys() | bm25_ranked.keys():
            score = sum(1.0 / (k + ranked[doc_id][0] + 1) for ranked in (dense_ranked, bm25_ranked) if doc_id in ranked)
            payload = (dense_ranked.get(doc_id) or bm25_ranked[doc_id])[1]
            fused.append((score, payload))
        fused.sort(key=lambda x: x[0], reverse=True)
        return [payload for _, payload in fused[:top_k]]

    def rerank(self, query: str, docs: List[Dict[str, Any]], top_n: int | None = None) -> List[Dict[str, Any]]:
        top_n = top_n or self.settings.rerank_top_n
        if not docs:
            return []
        scores = self.cross_encoder.predict([[query, d["text"]] for d in docs])
        order = np.argsort(scores)[::-1][:top_n]
        return [{**docs[i], "rerank_score": float(scores[i])} for i in order]

    def search(self, query: str) -> List[Dict[str, Any]]:
        return self.rerank(query, self.retrieve(query))
