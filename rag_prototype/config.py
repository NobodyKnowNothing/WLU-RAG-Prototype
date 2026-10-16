"""Central configuration for the RAG pipeline."""
from __future__ import annotations

import hashlib
import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent

load_dotenv(PROJECT_ROOT / ".env")


@dataclass(frozen=True)
class Settings:
    # Locations
    docs_dir: Path = PROJECT_ROOT / "files"
    cache_dir: Path = PROJECT_ROOT / ".rag_cache"

    # Chunking: ~400 words per chunk with ~10% overlap (≈6 chars/word)
    chunk_size: int = 2400
    chunk_overlap: int = 240
    separators: tuple[str, ...] = ("\n\n## ", "\n\n", "\n", ".", " ")

    # Models
    llm_model: str = "gemma-4-31b-it"
    llm_fallback_model: str = "gemma-4-26b-a4b-it"
    embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"
    reranker_model: str = "cross-encoder/ms-marco-MiniLM-L-6-v2"
    # Gemma 4 thinks by default and the hidden thinking tokens count against
    # max_output_tokens, which yields empty/truncated replies; keep it minimal.
    llm_thinking_level: str = "minimal"

    # Retrieval
    collection_name: str = "tutorial_docs"
    retrieve_top_k: int = 150
    rerank_top_n: int = 5
    rrf_k: int = 60

    # Tagging
    tag_workers: int = 8
    tag_prompt: str = (
        "You are a helpful assistant. Provide a 1-2 sentence semantic description of the following text. "
        "Reply with the description only."
    )

    api_key: str = field(
        default_factory=lambda: os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY", ""),
        repr=False,
    )

    @property
    def qdrant_path(self) -> Path:
        return self.cache_dir / "qdrant"

    @property
    def docs_cache_dir(self) -> Path:
        return self.cache_dir / "docs"

    @property
    def manifest_path(self) -> Path:
        return self.cache_dir / "manifest.json"

    @property
    def tag_cache_path(self) -> Path:
        return self.cache_dir / "tags.json"

    def chunking_fingerprint(self) -> str:
        """Changes whenever a setting that affects chunk boundaries changes."""
        return _fingerprint(
            {"chunk_size": self.chunk_size, "chunk_overlap": self.chunk_overlap, "separators": self.separators}
        )

    def index_fingerprint(self) -> str:
        """Changes whenever stored vectors/tags would no longer be valid."""
        return _fingerprint(
            {
                "chunking": self.chunking_fingerprint(),
                "embedding_model": self.embedding_model,
                "llm_model": self.llm_model,
                "llm_thinking_level": self.llm_thinking_level,
                "tag_prompt": self.tag_prompt,
            }
        )


def _fingerprint(obj: dict) -> str:
    raw = json.dumps(obj, sort_keys=True, default=str).encode()
    return hashlib.sha256(raw).hexdigest()[:16]


def settings_dict(settings: Settings) -> dict:
    d = asdict(settings)
    d.pop("api_key", None)
    return {k: str(v) if isinstance(v, Path) else v for k, v in d.items()}
