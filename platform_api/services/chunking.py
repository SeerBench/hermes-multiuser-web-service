"""Text chunking utilities for RAG ingestion."""

from __future__ import annotations


def chunk_text(text: str, *, chunk_size: int = 1200, overlap: int = 200) -> list[str]:
    text = text.strip()
    if not text:
        return []
    chunks: list[str] = []
    start = 0
    n = len(text)
    while start < n:
        end = min(start + chunk_size, n)
        chunks.append(text[start:end])
        if end >= n:
            break
        start = max(0, end - overlap)
    return chunks
