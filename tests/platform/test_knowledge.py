"""Knowledge ingestion + search MVP."""

from __future__ import annotations

from pathlib import Path

from gateway.web.sandbox import enter_user_context, get_user_workspace
from platform_api.deps import get_store
from platform_api.services.knowledge import search_knowledge


def test_upload_ingest_and_search(client, platform_env):
    reg = client.post(
        "/api/v1/auth/register",
        json={"email": "rag@example.com", "password": "password123"},
    )
    ws_id = reg.json()["workspace"]["id"]
    user_id = reg.json()["user"]["user_id"]

    content = b"Hermes platform knowledge base alpha beta gamma"
    up = client.post(
        f"/api/v1/workspaces/{ws_id}/files",
        files={"files": ("notes.txt", content, "text/plain")},
    )
    assert up.status_code == 200, up.text
    file_row = up.json()[0]
    assert file_row["status"] == "ready", file_row

    status = client.get(f"/api/v1/workspaces/{ws_id}/files/{file_row['id']}/status")
    assert status.status_code == 200

    store = get_store()
    ws = store.get_default_workspace(user_id)
    assert ws
    hits = search_knowledge(
        tenant_id=ws["tenant_id"],
        workspace_id=ws_id,
        query="knowledge base alpha",
        top_k=3,
    )
    assert hits
    assert any("alpha" in h["content"].lower() for h in hits)

    search_api = client.post(
        f"/api/v1/workspaces/{ws_id}/knowledge/search",
        json={"query": "gamma", "top_k": 2},
    )
    assert search_api.status_code == 200
    assert search_api.json()["results"]
