"""LLM semantic tagging of chunks, with a persistent per-chunk cache so that an
interrupted run (e.g. on quota exhaustion) resumes without repeating calls."""
from __future__ import annotations

import hashlib
import json
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Dict, List

from .llm import GemmaClient

log = logging.getLogger(__name__)


class TagCache:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self._data: Dict[str, str] = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}

    @staticmethod
    def key(model: str, prompt: str, chunk: Dict[str, Any]) -> str:
        md = chunk["metadata"]
        raw = f"{model}|{prompt}|{md['source']}|{md['page']}|{chunk['text']}".encode()
        return hashlib.sha256(raw).hexdigest()

    def get(self, key: str) -> str | None:
        return self._data.get(key)

    def put(self, key: str, value: str) -> None:
        with self._lock:
            self._data[key] = value
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self._data, ensure_ascii=False, indent=0), encoding="utf-8")
            tmp.replace(self.path)


def tag_chunks(chunks: List[Dict[str, Any]], client: GemmaClient, cache: TagCache, prompt: str, workers: int = 4) -> None:
    """Adds `metadata.semantic_description` and `enriched_text` to every chunk in place."""
    model = f"{client.models[0]}:{client.thinking_level}"

    def tag_one(chunk: Dict[str, Any]) -> None:
        key = TagCache.key(model, prompt, chunk)
        description = cache.get(key)
        if description is None:
            md = chunk["metadata"]
            user_prompt = f"Source Document: {md['source']}, Page {md['page']}\n\nText:\n{chunk['text']}"
            description = client.generate(
                [{"role": "system", "content": prompt}, {"role": "user", "content": user_prompt}],
                temperature=0.3,
                max_output_tokens=256,
            )
            cache.put(key, description)
        chunk["metadata"]["semantic_description"] = description
        chunk["enriched_text"] = f"Context: {description}\n\nContent: {chunk['text']}"

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for i, _ in enumerate(pool.map(tag_one, chunks), start=1):
            if i % 10 == 0 or i == len(chunks):
                log.info("  tagged %d/%d chunks", i, len(chunks))
