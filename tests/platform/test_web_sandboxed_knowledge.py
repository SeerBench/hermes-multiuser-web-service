"""web_knowledge_search reads Knowledge Center chunks, not DocumentChunk alone."""

from __future__ import annotations

import json

from gateway.web.sandbox import enter_user_context
from gateway.web.tools import sandboxed_knowledge_search  # noqa: F401 — register
from gateway.web.tools.sandboxed_knowledge_search import web_knowledge_search
from platform_api.deps import get_store
from tests.platform.conftest import bind_upstream_key, register_user


def _user(client, mock_upstream_key, email: str = "agent-kb@example.com"):
    del mock_upstream_key
    body, _ = register_user(client, email=email)
    bind_upstream_key(client)
    get_store.cache_clear()
    return body["user"]["user_id"], body["workspace"]["id"]


def test_web_knowledge_search_empty_hint(client, mock_upstream_key):
    user_id, _wid = _user(client, mock_upstream_key)
    with enter_user_context(user_id):
        raw = web_knowledge_search(query="anything")
    data = json.loads(raw)
    assert data["success"] is True
    assert data["results"] == []
    assert "Knowledge Center" in data.get("hint", "")


def test_web_knowledge_search_hits_ready_base(client, mock_upstream_key):
    user_id, wid = _user(client, mock_upstream_key, email="agent-kb2@example.com")
    up = client.post(
        f"/api/v1/workspaces/{wid}/files",
        files={
            "files": (
                "notes.txt",
                b"Hermes knowledge center unique token quokka",
                "text/plain",
            )
        },
    )
    assert up.status_code == 200, up.text
    fid = up.json()[0]["id"]

    created = client.post(
        f"/api/v1/workspaces/{wid}/knowledge-bases",
        json={"name": "Agent KB", "file_ids": [fid]},
    )
    assert created.status_code == 200, created.text
    assert created.json()["status"] == "ready"

    with enter_user_context(user_id):
        raw = web_knowledge_search(query="quokka knowledge")
    data = json.loads(raw)
    assert data["success"] is True
    assert data["results"]
    assert any("quokka" in h["content"].lower() for h in data["results"])

    # Usage Center ledger row for knowledge search
    logs = client.get("/api/v1/usage/logs?type=knowledge")
    assert logs.status_code == 200
    assert any(
        item.get("tool_name") == "web_knowledge_search"
        for item in logs.json()["items"]
    )
