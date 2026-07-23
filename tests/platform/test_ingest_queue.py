"""Ingest queue: sync fallback, Redis enqueue, retry/DLQ."""

from __future__ import annotations

import json
from collections import defaultdict

import pytest

from platform_api.services import queue as queue_mod
from tests.platform.conftest import bind_upstream_key, register_user


class _FakeRedis:
    def __init__(self) -> None:
        self.lists: dict[str, list[str]] = defaultdict(list)

    def rpush(self, key: str, value: str) -> int:
        self.lists[key].append(value)
        return len(self.lists[key])

    def brpop(self, key: str, timeout: int = 0):
        if self.lists[key]:
            return key, self.lists[key].pop(0)
        return None

    def llen(self, key: str) -> int:
        return len(self.lists[key])


def test_enqueue_sync_fallback_without_redis(client, mock_upstream_key, monkeypatch):
    monkeypatch.delenv("REDIS_URL", raising=False)
    reg, _ = register_user(client, email="sync-ingest@example.com")
    bind_upstream_key(client)
    ws_id = reg["workspace"]["id"]
    up = client.post(
        f"/api/v1/workspaces/{ws_id}/files",
        files={"files": ("notes.txt", b"alpha beta gamma knowledge", "text/plain")},
    )
    assert up.status_code == 200, up.text
    assert up.json()[0]["status"] == "ready"


def test_enqueue_async_when_redis_set(client, mock_upstream_key, monkeypatch):
    fake = _FakeRedis()
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/15")
    monkeypatch.setattr(queue_mod, "_redis", lambda: fake)

    reg, _ = register_user(client, email="async-ingest@example.com")
    bind_upstream_key(client)
    ws_id = reg["workspace"]["id"]
    up = client.post(
        f"/api/v1/workspaces/{ws_id}/files",
        files={"files": ("notes.txt", b"queued for worker", "text/plain")},
    )
    assert up.status_code == 200, up.text
    row = up.json()[0]
    assert row["status"] == "pending"
    assert len(fake.lists[queue_mod.INGEST_QUEUE]) == 1
    job = json.loads(fake.lists[queue_mod.INGEST_QUEUE][0])
    assert job["file_id"] == row["id"]
    assert job["workspace_id"] == ws_id


def test_requeue_then_dlq(monkeypatch):
    fake = _FakeRedis()
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/15")
    monkeypatch.setattr(queue_mod, "_redis", lambda: fake)
    monkeypatch.setattr(queue_mod.time, "sleep", lambda _s: None)

    job = {
        "file_id": "f1",
        "user_id": "u1",
        "workspace_id": "ws1",
        "attempt": 0,
    }
    assert queue_mod.requeue_or_deadletter(job, error="boom1") == "retry"
    assert len(fake.lists[queue_mod.INGEST_QUEUE]) == 1
    retried = json.loads(fake.lists[queue_mod.INGEST_QUEUE].pop(0))
    assert retried["attempt"] == 1

    retried["attempt"] = 2  # next failure hits MAX_ATTEMPTS (3)
    assert queue_mod.requeue_or_deadletter(retried, error="boom2") == "dlq"
    assert fake.llen(queue_mod.INGEST_DLQ) == 1
    assert queue_mod.dlq_length() == 1


def test_reingest_idempotent_chunk_count(client, mock_upstream_key, monkeypatch):
    """Second ingest for the same file replaces chunks (no duplicate rows)."""
    monkeypatch.delenv("REDIS_URL", raising=False)
    from sqlalchemy import func, select

    from gateway.web.platform.models import DocumentChunk
    from platform_api.deps import get_store
    from platform_api.services.ingest import ingest_file_record

    reg, _ = register_user(client, email="idempotent@example.com")
    bind_upstream_key(client)
    ws_id = reg["workspace"]["id"]
    user_id = reg["user"]["user_id"]
    up = client.post(
        f"/api/v1/workspaces/{ws_id}/files",
        files={"files": ("n.txt", b"chunk one alpha", "text/plain")},
    )
    assert up.status_code == 200
    file_id = up.json()[0]["id"]
    store = get_store()

    def _count() -> int:
        with store._session_factory() as db:
            return int(
                db.execute(
                    select(func.count())
                    .select_from(DocumentChunk)
                    .where(DocumentChunk.file_id == file_id)
                ).scalar_one()
                or 0
            )

    n1 = _count()
    assert n1 >= 1
    ingest_file_record(file_id, user_id)
    assert _count() == n1


def test_concurrent_enqueue_keeps_user_isolation(client, mock_upstream_key, monkeypatch):
    """Two users' async jobs carry distinct user_id / workspace_id."""
    fake = _FakeRedis()
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/15")
    monkeypatch.setattr(queue_mod, "_redis", lambda: fake)

    reg_a, _ = register_user(client, email="iso-a@example.com")
    _, cookie_a = bind_upstream_key(client)
    ws_a = reg_a["workspace"]["id"]
    uid_a = reg_a["user"]["user_id"]

    # Second user replaces the TestClient session cookie
    reg_b, _ = register_user(client, email="iso-b@example.com")
    bind_upstream_key(client)
    ws_b = reg_b["workspace"]["id"]
    uid_b = reg_b["user"]["user_id"]

    up_b = client.post(
        f"/api/v1/workspaces/{ws_b}/files",
        files={"files": ("b.txt", b"bob file", "text/plain")},
    )
    assert up_b.status_code == 200, up_b.text

    up_a = client.post(
        f"/api/v1/workspaces/{ws_a}/files",
        files={"files": ("a.txt", b"alice file", "text/plain")},
        cookies={"hermes_session": cookie_a},
    )
    assert up_a.status_code == 200, up_a.text

    jobs = [json.loads(raw) for raw in fake.lists[queue_mod.INGEST_QUEUE]]
    assert len(jobs) >= 2
    by_ws = {j["workspace_id"]: j for j in jobs}
    assert by_ws[ws_a]["user_id"] == uid_a
    assert by_ws[ws_b]["user_id"] == uid_b
    assert by_ws[ws_a]["file_id"] != by_ws[ws_b]["file_id"]

