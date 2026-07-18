"""Memory Center: structured items, approve/reject, projection, isolation."""

from __future__ import annotations

from gateway.web.sandbox import enter_user_context
from tests.platform.conftest import bind_upstream_key, register_user
from tools.memory_tool import ENTRY_DELIMITER, MemoryStore


def _setup_user(client, mock_upstream_key, email: str = "mem@example.com"):
    del mock_upstream_key
    body, _ = register_user(client, email=email)
    bind_upstream_key(client)
    return body["user"]["user_id"], body["workspace"]["id"]


def test_create_list_and_stats(client, mock_upstream_key):
    _uid, wid = _setup_user(client, mock_upstream_key)
    created = client.post(
        f"/api/v1/workspaces/{wid}/memory/items",
        json={
            "category": "preference",
            "content": "Prefers structured answers",
            "confidence": 0.9,
            "importance": 80,
        },
    )
    assert created.status_code == 200, created.text
    item = created.json()
    assert item["status"] == "active"
    assert item["source"] == "manual"
    assert item["category"] == "preference"

    listed = client.get(f"/api/v1/workspaces/{wid}/memory/items")
    assert listed.status_code == 200
    rows = listed.json()["items"]
    assert len(rows) == 1
    assert rows[0]["id"] == item["id"]

    stats = client.get(f"/api/v1/workspaces/{wid}/memory/stats")
    assert stats.status_code == 200
    body = stats.json()
    assert body["total"] == 1
    assert body["pending"] == 0
    assert body["last_updated_at"]


def test_approve_projects_to_memory_md(client, mock_upstream_key):
    user_id, wid = _setup_user(client, mock_upstream_key, email="proj@example.com")
    pending = client.post(
        f"/api/v1/workspaces/{wid}/memory/items",
        json={
            "category": "knowledge",
            "content": "Uses Docker for Hermes deploys",
            "status": "pending",
            "source": "agent_tool",
            "confidence": 0.85,
        },
    )
    assert pending.status_code == 200, pending.text
    item_id = pending.json()["id"]

    ok = client.post(f"/api/v1/workspaces/{wid}/memory/items/{item_id}/approve")
    assert ok.status_code == 200, ok.text
    assert ok.json()["status"] == "active"

    with enter_user_context(user_id):
        store = MemoryStore()
        store.load_from_disk()
        joined = ENTRY_DELIMITER.join(store.memory_entries)
        assert "Uses Docker for Hermes deploys" in joined


def test_reject_does_not_project(client, mock_upstream_key):
    user_id, wid = _setup_user(client, mock_upstream_key, email="rej@example.com")
    pending = client.post(
        f"/api/v1/workspaces/{wid}/memory/items",
        json={
            "category": "preference",
            "content": "Should never appear on disk",
            "status": "pending",
            "source": "agent_tool",
        },
    )
    item_id = pending.json()["id"]
    rejected = client.post(
        f"/api/v1/workspaces/{wid}/memory/items/{item_id}/reject"
    )
    assert rejected.status_code == 200
    assert rejected.json()["status"] == "archived"

    with enter_user_context(user_id):
        path = __import__("pathlib").Path(
            __import__("hermes_constants").get_hermes_home()
        ) / "memories" / "MEMORY.md"
        text = path.read_text(encoding="utf-8") if path.is_file() else ""
        assert "Should never appear on disk" not in text


def test_profile_projects_to_user_md(client, mock_upstream_key):
    user_id, wid = _setup_user(client, mock_upstream_key, email="prof@example.com")
    created = client.post(
        f"/api/v1/workspaces/{wid}/memory/items",
        json={
            "category": "profile",
            "content": "Senior Python engineer",
            "status": "active",
        },
    )
    assert created.status_code == 200, created.text

    with enter_user_context(user_id):
        store = MemoryStore()
        store.load_from_disk()
        joined = ENTRY_DELIMITER.join(store.user_entries)
        assert "Senior Python engineer" in joined


def test_update_and_delete_reprojects(client, mock_upstream_key):
    user_id, wid = _setup_user(client, mock_upstream_key, email="upd@example.com")
    created = client.post(
        f"/api/v1/workspaces/{wid}/memory/items",
        json={"category": "project", "content": "Hermes MVP", "status": "active"},
    )
    item_id = created.json()["id"]
    patched = client.put(
        f"/api/v1/workspaces/{wid}/memory/items/{item_id}",
        json={"content": "Hermes Memory Center"},
    )
    assert patched.status_code == 200
    assert patched.json()["content"] == "Hermes Memory Center"

    with enter_user_context(user_id):
        store = MemoryStore()
        store.load_from_disk()
        assert "Hermes Memory Center" in ENTRY_DELIMITER.join(store.memory_entries)

    deleted = client.delete(f"/api/v1/workspaces/{wid}/memory/items/{item_id}")
    assert deleted.status_code == 200
    with enter_user_context(user_id):
        store = MemoryStore()
        store.load_from_disk()
        assert "Hermes Memory Center" not in ENTRY_DELIMITER.join(
            store.memory_entries
        )


def test_migrate_from_files_is_idempotent(client, mock_upstream_key):
    user_id, wid = _setup_user(client, mock_upstream_key, email="mig@example.com")
    with enter_user_context(user_id) as ws:
        mem = ws / "memories" / "MEMORY.md"
        mem.parent.mkdir(parents=True, exist_ok=True)
        mem.write_text(
            f"Fact A{ENTRY_DELIMITER}Fact B",
            encoding="utf-8",
        )
        (ws / "memories" / "USER.md").write_text("User is Alice", encoding="utf-8")

    first = client.post(f"/api/v1/workspaces/{wid}/memory/migrate-from-files")
    assert first.status_code == 200, first.text
    assert first.json()["imported"] == 3

    second = client.post(f"/api/v1/workspaces/{wid}/memory/migrate-from-files")
    assert second.status_code == 200
    assert second.json()["imported"] == 0

    listed = client.get(f"/api/v1/workspaces/{wid}/memory/items?status=active")
    assert len(listed.json()["items"]) == 3


def test_user_cannot_list_other_users_memory_items(client, mock_upstream_key):
    _uid_a, wid_a = _setup_user(client, mock_upstream_key, email="a@example.com")
    client.post(
        f"/api/v1/workspaces/{wid_a}/memory/items",
        json={"category": "preference", "content": "alice secret"},
    )

    # Switch to Bob (new session cookie overwrites)
    _uid_b, wid_b = _setup_user(client, mock_upstream_key, email="b@example.com")
    denied = client.get(f"/api/v1/workspaces/{wid_a}/memory/items")
    assert denied.status_code == 404

    ok = client.get(f"/api/v1/workspaces/{wid_b}/memory/items")
    assert ok.status_code == 200
    assert ok.json()["items"] == []


def test_filter_and_sort(client, mock_upstream_key):
    _uid, wid = _setup_user(client, mock_upstream_key, email="sort@example.com")
    client.post(
        f"/api/v1/workspaces/{wid}/memory/items",
        json={
            "category": "preference",
            "content": "likes risk control",
            "importance": 10,
        },
    )
    client.post(
        f"/api/v1/workspaces/{wid}/memory/items",
        json={
            "category": "project",
            "content": "Hermes RAG stack",
            "importance": 90,
        },
    )
    filtered = client.get(
        f"/api/v1/workspaces/{wid}/memory/items?category=project&sort=importance"
    )
    assert filtered.status_code == 200
    items = filtered.json()["items"]
    assert len(items) == 1
    assert items[0]["importance"] == 90

    q = client.get(f"/api/v1/workspaces/{wid}/memory/items?q=risk")
    assert len(q.json()["items"]) == 1
    assert "risk" in q.json()["items"][0]["content"]
