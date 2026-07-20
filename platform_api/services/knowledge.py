"""Embedding + hybrid search (cosine on embedding_json, keyword fallback)."""

from __future__ import annotations

import json
import logging
import math
import os
import re
from typing import Any, List, Optional

from sqlalchemy import select

from gateway.web.platform.models import DocumentChunk, FileRecord
from platform_api.deps import get_store

logger = logging.getLogger("hermes.platform.knowledge")

# Cap in-process cosine scan per workspace (no pgvector index on SQLite).
_MAX_COSINE_CHUNKS = int(os.environ.get("HERMES_COSINE_MAX_CHUNKS", "5000"))


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


def cosine_similarity(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(x * x for x in b)) or 1.0
    return dot / (na * nb)


def parse_embedding(raw: Optional[str]) -> Optional[list[float]]:
    if not raw:
        return None
    try:
        vec = json.loads(raw)
        if isinstance(vec, list) and vec and all(isinstance(x, (int, float)) for x in vec):
            return [float(x) for x in vec]
    except (TypeError, json.JSONDecodeError):
        return None
    return None


def keyword_score(query: str, content: str) -> float:
    q_tokens = _tokenize(query)
    c_tokens = _tokenize(content)
    if not q_tokens or not c_tokens:
        return 0.0
    return len(q_tokens & c_tokens) / max(len(q_tokens), 1)


def search_knowledge(
    *,
    tenant_id: str,
    workspace_id: str,
    query: str,
    top_k: int = 5,
) -> List[dict[str, Any]]:
    store = get_store()
    q_emb = embed_text(query)
    with store._session_factory() as db:
        rows = db.execute(
            select(DocumentChunk, FileRecord.filename)
            .join(FileRecord, FileRecord.id == DocumentChunk.file_id)
            .where(
                DocumentChunk.tenant_id == tenant_id,
                DocumentChunk.workspace_id == workspace_id,
            )
            .limit(_MAX_COSINE_CHUNKS)
        ).all()

    if len(rows) >= _MAX_COSINE_CHUNKS:
        logger.warning(
            "cosine scan hit cap=%s workspace=%s",
            _MAX_COSINE_CHUNKS,
            workspace_id,
        )

    scored: list[tuple[float, DocumentChunk, str]] = []
    used_cosine = 0
    for chunk, filename in rows:
        emb = parse_embedding(chunk.embedding_json)
        if emb and len(emb) == len(q_emb):
            score = cosine_similarity(q_emb, emb)
            used_cosine += 1
        else:
            score = keyword_score(query, chunk.content)
        if score > 0:
            scored.append((score, chunk, filename))

    if used_cosine == 0 and scored:
        logger.debug("search_knowledge workspace=%s keyword-only", workspace_id)

    scored.sort(key=lambda x: x[0], reverse=True)
    out: list[dict[str, Any]] = []
    for score, chunk, filename in scored[:top_k]:
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
