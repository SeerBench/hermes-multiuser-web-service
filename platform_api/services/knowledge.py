"""Embedding + vector-less fallback search for MVP."""

from __future__ import annotations

import json
import math
import os
import re
from typing import Any, List

from sqlalchemy import select

from gateway.web.platform.models import DocumentChunk, FileRecord
from platform_api.deps import get_store


def _tokenize(text: str) -> set[str]:
    return set(re.findall(r"[a-zA-Z0-9\u4e00-\u9fff]+", text.lower()))


def embed_text(text: str) -> list[float]:
    """MVP embedding: optional OpenAI-compatible API, else bag-of-tokens hash vector."""
    api_base = os.environ.get("EMBEDDING_API_BASE_URL", "").strip()
    api_key = os.environ.get("EMBEDDING_API_KEY", "").strip()
    model = os.environ.get("EMBEDDING_MODEL", "text-embedding-3-small")
    if api_base and api_key:
        import httpx

        with httpx.Client(timeout=60.0) as client:
            resp = client.post(
                f"{api_base.rstrip('/')}/embeddings",
                headers={"Authorization": f"Bearer {api_key}"},
                json={"model": model, "input": text},
            )
            resp.raise_for_status()
            data = resp.json()
            return list(data["data"][0]["embedding"])
    # deterministic pseudo-embedding for offline/tests
    tokens = sorted(_tokenize(text))
    vec = [0.0] * 64
    for i, tok in enumerate(tokens[:64]):
        vec[i % 64] += (hash(tok) % 1000) / 1000.0
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / norm for x in vec]


def search_knowledge(
    *,
    tenant_id: str,
    workspace_id: str,
    query: str,
    top_k: int = 5,
) -> List[dict[str, Any]]:
    store = get_store()
    q_tokens = _tokenize(query)
    with store._session_factory() as db:
        rows = db.execute(
            select(DocumentChunk, FileRecord.filename)
            .join(FileRecord, FileRecord.id == DocumentChunk.file_id)
            .where(
                DocumentChunk.tenant_id == tenant_id,
                DocumentChunk.workspace_id == workspace_id,
            )
        ).all()

    scored: list[tuple[float, DocumentChunk, str]] = []
    for chunk, filename in rows:
        c_tokens = _tokenize(chunk.content)
        if not c_tokens:
            continue
        score = len(q_tokens & c_tokens) / max(len(q_tokens), 1)
        scored.append((score, chunk, filename))
    scored.sort(key=lambda x: x[0], reverse=True)
    out: list[dict[str, Any]] = []
    for score, chunk, filename in scored[:top_k]:
        if score <= 0:
            continue
        out.append({
            "chunk_id": chunk.id,
            "file_id": chunk.file_id,
            "filename": filename,
            "content": chunk.content[:2000],
            "score": round(score, 4),
        })
    return out


def store_chunks(
    *,
    tenant_id: str,
    workspace_id: str,
    file_id: str,
    chunks: list[str],
) -> None:
    from gateway.web.platform.database import session_scope

    store = get_store()
    with session_scope(store._engine) as db:
        for i, text in enumerate(chunks):
            emb = embed_text(text)
            db.add(
                DocumentChunk(
                    tenant_id=tenant_id,
                    workspace_id=workspace_id,
                    file_id=file_id,
                    chunk_index=i,
                    content=text,
                    embedding_json=json.dumps(emb),
                )
            )
