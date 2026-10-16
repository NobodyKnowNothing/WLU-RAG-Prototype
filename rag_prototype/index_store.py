"""Persistent, incremental index.

Layout of the cache directory (default `.rag_cache/`):

    manifest.json            which files are indexed, by content hash
    tags.json                LLM descriptions keyed by chunk hash (resumable tagging)
    docs/<sha>_<fp>.json     processed chunks (text, page, description) per file version
    qdrant/                  local on-disk Qdrant vector store

A file is only re-processed when its content hash changes. Settings that
invalidate vectors (chunking, embedding model, tagging model) are captured in
an index fingerprint; changing them triggers a rebuild (cached tags for
identical chunks are still reused).
"""
from __future__ import annotations

import hashlib
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path
from typing import Any, Callable, Dict, List

from qdrant_client import QdrantClient
from qdrant_client.models import Distance, FieldCondition, Filter, FilterSelector, MatchValue, PointStruct, VectorParams

from .chunking import load_and_chunk_pdf
from .config import Settings
from .llm import GemmaClient
from .tagging import TagCache, tag_chunks

log = logging.getLogger(__name__)

SUPPORTED_SUFFIXES = {".pdf"}


@dataclass
class SyncReport:
    added: List[str] = field(default_factory=list)
    updated: List[str] = field(default_factory=list)
    unchanged: List[str] = field(default_factory=list)
    repaired: List[str] = field(default_factory=list)
    removed: List[str] = field(default_factory=list)

    def __str__(self) -> str:
        parts = [f"{name}={len(getattr(self, name))}" for name in ("added", "updated", "unchanged", "repaired", "removed")]
        return "Sync: " + ", ".join(parts)


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


class IndexStore:
    def __init__(self, settings: Settings):
        self.settings = settings
        settings.docs_cache_dir.mkdir(parents=True, exist_ok=True)
        self.manifest = self._load_manifest()

    # ------------------------------------------------------------------ setup
    @cached_property
    def embedder(self):
        from sentence_transformers import SentenceTransformer

        return SentenceTransformer(self.settings.embedding_model)

    @cached_property
    def qdrant(self) -> QdrantClient:
        client = QdrantClient(path=str(self.settings.qdrant_path))
        if not client.collection_exists(self.settings.collection_name):
            dim = self.embedder.get_embedding_dimension()
            client.create_collection(
                collection_name=self.settings.collection_name,
                vectors_config=VectorParams(size=dim, distance=Distance.COSINE),
            )
        return client

    def close(self) -> None:
        if "qdrant" in self.__dict__:
            self.qdrant.close()

    # --------------------------------------------------------------- manifest
    def _load_manifest(self) -> Dict[str, Any]:
        path = self.settings.manifest_path
        if path.exists():
            manifest = json.loads(path.read_text(encoding="utf-8"))
            if manifest.get("fingerprint") == self.settings.index_fingerprint():
                return manifest
            log.warning("Index settings changed since last run; rebuilding index")
            self._reset_vectors()
        return {"fingerprint": self.settings.index_fingerprint(), "docs": {}}

    def _save_manifest(self) -> None:
        tmp = self.settings.manifest_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.manifest, indent=2), encoding="utf-8")
        tmp.replace(self.settings.manifest_path)

    def _reset_vectors(self) -> None:
        if self.qdrant.collection_exists(self.settings.collection_name):
            self.qdrant.delete_collection(self.settings.collection_name)
        self.qdrant.close()
        del self.__dict__["qdrant"]  # recreated lazily with the right dimension

    def _doc_cache_path(self, sha: str) -> Path:
        return self.settings.docs_cache_dir / f"{sha}_{self.settings.index_fingerprint()}.json"

    # ------------------------------------------------------------------- sync
    def sync(self, llm_factory: Callable[[], GemmaClient], force: bool = False) -> SyncReport:
        """Brings the index in line with the files in `docs_dir`."""
        report = SyncReport()
        docs = self.manifest["docs"]
        files = sorted(p for p in self.settings.docs_dir.iterdir() if p.suffix.lower() in SUPPORTED_SUFFIXES)
        current = {p.name: p for p in files}

        for name in sorted(set(docs) - set(current)):
            log.info("Removing %s (file no longer present)", name)
            self._delete_doc_points(docs[name]["sha256"])
            docs.pop(name)
            self._save_manifest()
            report.removed.append(name)

        llm: GemmaClient | None = None
        tag_cache = TagCache(self.settings.tag_cache_path)
        for name, path in current.items():
            sha = file_sha256(path)
            entry = docs.get(name)

            if not force and entry and entry["sha256"] == sha and self._doc_cache_path(sha).exists():
                if self._count_doc_points(sha) == entry["n_chunks"]:
                    log.info("Skipping %s (unchanged)", name)
                    report.unchanged.append(name)
                else:
                    log.info("Re-embedding %s from cache (vector store out of sync)", name)
                    self._delete_doc_points(sha)
                    self._upsert(self._read_doc_cache(sha))
                    report.repaired.append(name)
                continue

            log.info("%s %s", "Updating" if entry else "Indexing", name)
            if entry:
                self._delete_doc_points(entry["sha256"])

            chunks = load_and_chunk_pdf(path, self.settings)
            for c in chunks:
                c["id"] = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{sha}:{c['chunk_index']}"))
                c["metadata"]["doc_sha256"] = sha
            log.info("  %d chunks; tagging with %s", len(chunks), self.settings.llm_model)

            if llm is None:
                llm = llm_factory()
            tag_chunks(chunks, llm, tag_cache, self.settings.tag_prompt, workers=self.settings.tag_workers)

            self._doc_cache_path(sha).write_text(json.dumps(chunks, ensure_ascii=False, indent=1), encoding="utf-8")
            self._delete_doc_points(sha)
            self._upsert(chunks)
            docs[name] = {"sha256": sha, "n_chunks": len(chunks), "indexed_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
            self._save_manifest()
            (report.updated if entry else report.added).append(name)

        self._prune_doc_cache()
        return report

    # ---------------------------------------------------------------- helpers
    def _read_doc_cache(self, sha: str) -> List[Dict[str, Any]]:
        return json.loads(self._doc_cache_path(sha).read_text(encoding="utf-8"))

    def _doc_filter(self, sha: str) -> Filter:
        return Filter(must=[FieldCondition(key="metadata.doc_sha256", match=MatchValue(value=sha))])

    def _count_doc_points(self, sha: str) -> int:
        return self.qdrant.count(self.settings.collection_name, count_filter=self._doc_filter(sha), exact=True).count

    def _delete_doc_points(self, sha: str) -> None:
        self.qdrant.delete(self.settings.collection_name, points_selector=FilterSelector(filter=self._doc_filter(sha)))

    def _upsert(self, chunks: List[Dict[str, Any]]) -> None:
        if not chunks:
            return
        vectors = self.embedder.encode([c["enriched_text"] for c in chunks], normalize_embeddings=True)
        points = [
            PointStruct(id=c["id"], vector=v.tolist(), payload={"text": c["text"], "metadata": c["metadata"]})
            for c, v in zip(chunks, vectors)
        ]
        self.qdrant.upsert(self.settings.collection_name, points=points)

    def _prune_doc_cache(self) -> None:
        keep = {self._doc_cache_path(d["sha256"]).name for d in self.manifest["docs"].values()}
        for p in self.settings.docs_cache_dir.glob("*.json"):
            if p.name not in keep:
                p.unlink()

    # ----------------------------------------------------------------- access
    def all_chunks(self) -> List[Dict[str, Any]]:
        chunks: List[Dict[str, Any]] = []
        for name in sorted(self.manifest["docs"]):
            chunks.extend(self._read_doc_cache(self.manifest["docs"][name]["sha256"]))
        return chunks
