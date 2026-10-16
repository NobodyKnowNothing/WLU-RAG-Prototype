"""PDF loading and chunking."""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List

from langchain_text_splitters import RecursiveCharacterTextSplitter
from pypdf import PdfReader

from .config import Settings


def load_and_chunk_pdf(path: Path, settings: Settings) -> List[Dict[str, Any]]:
    """Extracts text page by page and splits it into chunks, keeping the
    1-based page number with each chunk. Section boundaries are respected by
    preferring double-newline separators."""
    splitter = RecursiveCharacterTextSplitter(
        separators=list(settings.separators),
        chunk_size=settings.chunk_size,
        chunk_overlap=settings.chunk_overlap,
        length_function=len,
    )

    chunks: List[Dict[str, Any]] = []
    reader = PdfReader(str(path))
    for page_num, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        for piece in splitter.split_text(text):
            if not piece.strip():
                continue
            chunks.append(
                {
                    "chunk_index": len(chunks),
                    "text": piece,
                    "metadata": {"source": path.name, "page": page_num},
                }
            )
    return chunks
