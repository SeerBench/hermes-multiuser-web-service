"""In-process cosine ranking beats keyword when embeddings are fixed."""

from __future__ import annotations

import json

import pytest

from gateway.web.platform.database import session_scope
from gateway.web.platform.models import DocumentChunk, KnowledgeBase, KnowledgeChunk
from platform_api.deps import get_store
from platform_api.services import knowledge as knowledge_mod
from platform_api.services import knowledge_center as kc_mod
from platform_api.services.knowledge import (
    cosine_similarity,
    keyword_score,
    parse_embedding,
    search_knowledge,
)
from platform_api.services.knowledge_center import search_knowledge_chunks
from tests.platform.conftest import bind_upstream_key, register_user


def _unit(vec: list[float]) -> list[float]:
    n = sum(x * x for x in vec) ** 0.5 or 1.0
    return [x / n for x in vec]


def test_cosine_helpers():
    assert cosine_similarity([1.0, 0.0], [1.0, 0.0]) == pytest.approx(1.0)
    assert cosine_similarity([1.0, 0.0], [0.0, 1.0]) == pytest.approx(0.0)
    assert cosine_similarity([1.0], [1.0, 0.0]) == 0.0
    assert parse_embedding(json.dumps([0.1, 0.2])) == [0.1, 0.2]
    assert parse_embedding("not-json") is None
    assert parse_embedding(None) is None
    assert keyword_score("alpha beta", "alpha gamma") == pytest.approx(0.5)



def test_search_knowledge_prefers_cosine_over_keyword(client, mock_upstream_key, monkeypatch):
    """Query shares no tokens with the semantic hit, but vectors align."""
    # Query embedding: [1,0,...]; semantic doc close; keyword-only doc [0,1,...]
    q_vec = _unit([1.0] + [0.0] * 63)
    semantic_vec = _unit([0.95, 0.05] + [0.0] * 62)
    # Still above zero vs query, but clearly worse than semantic_vec
    distractor_vec = _unit([0.2, 0.98] + [0.0] * 62)

    monkeypatch.setattr(knowledge_mod, "embed_text", lambda _t: q_vec)

    reg, _ = register_user(client, email="cosine@example.com")
    bind_upstream_key(client)
    ws_id = reg["workspace"]["id"]
    tenant_id = reg["user"]["tenant_id"]
    user_id = reg["user"]["user_id"]

    up = client.post(
        f"/api/v1/workspaces/{ws_id}/files",
        files={"files": ("a.txt", b"placeholder content for ingest", "text/plain")},
        params={"ingest": "false"},
    )
    assert up.status_code == 200, up.text
    file_id = up.json()[0]["id"]

    store = get_store()
    with session_scope(store._engine) as db:
        db.add(
            DocumentChunk(
                tenant_id=tenant_id,
                workspace_id=ws_id,
                file_id=file_id,
                chunk_index=0,
                content="automobile engine torque curve",  # no token overlap with query
                embedding_json=json.dumps(semantic_vec),
            )
        )
        db.add(
            DocumentChunk(
                tenant_id=tenant_id,
                workspace_id=ws_id,
                file_id=file_id,
                chunk_index=1,
                content="vehicle vehicle vehicle",  # shared token, weaker vector
                embedding_json=json.dumps(distractor_vec),
            )
        )

    hits = search_knowledge(
        tenant_id=tenant_id,
        workspace_id=ws_id,
        query="paraphrase about vehicle dynamics",
        top_k=2,
    )
    assert len(hits) >= 2
    # Cosine ranks the synonym-like chunk above the keyword-heavy distractor
    assert "automobile" in hits[0]["content"]
    assert hits[0]["score"] > hits[1]["score"]


def test_knowledge_chunks_cosine_and_keyword_fallback(
    client, mock_upstream_key, monkeypatch
):
    q_vec = _unit([1.0] + [0.0] * 63)
    good = _unit([1.0] + [0.0] * 63)
    monkeypatch.setattr(knowledge_mod, "embed_text", lambda _t: q_vec)
    monkeypatch.setattr(kc_mod, "embed_text", lambda _t: q_vec)

    reg, _ = register_user(client, email="kc-cosine@example.com")
    bind_upstream_key(client)
    ws_id = reg["workspace"]["id"]
    tenant_id = reg["user"]["tenant_id"]
    user_id = reg["user"]["user_id"]

    store = get_store()
    with session_scope(store._engine) as db:
        kb = KnowledgeBase(
            tenant_id=tenant_id,
            workspace_id=ws_id,
            user_id=user_id,
            name="KB",
            category="tech",
            status="ready",
        )
        db.add(kb)
        db.flush()
        db.add(
            KnowledgeChunk(
                tenant_id=tenant_id,
                workspace_id=ws_id,
                user_id=user_id,
                knowledge_id=kb.id,
                file_id=None,
                chunk_index=0,
                content="neural network training tips",
                embedding_json=json.dumps(good),
            )
        )
        db.add(
            KnowledgeChunk(
                tenant_id=tenant_id,
                workspace_id=ws_id,
                user_id=user_id,
                knowledge_id=kb.id,
                file_id=None,
                chunk_index=1,
                content="unrelated gardening soil",
                embedding_json=None,  # keyword fallback path
            )
        )

    hits = search_knowledge_chunks(
        tenant_id=tenant_id,
        workspace_id=ws_id,
        user_id=user_id,
        query="deep learning",
        top_k=2,
    )
    assert hits
    assert "neural" in hits[0]["content"]
