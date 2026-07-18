"""Usage Center: create via service/tracker, summary isolation, POST /record 403."""

from __future__ import annotations

from gateway.web.usage_tracker import track, track_chat_turn
from platform_api.deps import get_store
from platform_api.services import usage as usage_svc
from tests.platform.conftest import bind_upstream_key, register_user


def _setup(client, mock_upstream_key, email: str = "usage@example.com"):
    del mock_upstream_key
    body, _ = register_user(client, email=email)
    bind_upstream_key(client)
    get_store.cache_clear()
    return body["user"]["user_id"], body["workspace"]["id"]


def test_track_chat_and_summary(client, mock_upstream_key):
    user_id, wid = _setup(client, mock_upstream_key)
    row = track_chat_turn(
        user_id=user_id,
        session_id="sess-1",
        model="gpt-test",
        usage={"input_tokens": 10, "output_tokens": 20, "total_tokens": 30},
        workspace_id=wid,
    )
    assert row is not None
    assert row["type"] == "chat"
    assert row["total_tokens"] == 30
    assert row["model"] == "gpt-test"

    summary = client.get("/api/v1/usage/summary")
    assert summary.status_code == 200, summary.text
    body = summary.json()
    assert body["today"]["requests"] >= 1
    assert body["today"]["tokens"] >= 30
    assert body["month"]["requests"] >= 1

    trend = client.get("/api/v1/usage/trend?days=7")
    assert trend.status_code == 200
    assert len(trend.json()["points"]) == 7
    assert sum(p["requests"] for p in trend.json()["points"]) >= 1

    by_model = client.get("/api/v1/usage/by-model")
    assert by_model.status_code == 200
    models = by_model.json()["items"]
    assert any(m["model"] == "gpt-test" for m in models)

    logs = client.get("/api/v1/usage/logs?type=chat")
    assert logs.status_code == 200
    items = logs.json()["items"]
    assert items
    assert items[0]["user_id"] == user_id
    assert "api_key" not in (items[0].get("metadata") or {})


def test_metadata_strips_secrets(client, mock_upstream_key):
    user_id, _wid = _setup(client, mock_upstream_key, email="sec@example.com")
    row = usage_svc.create_record(
        user_id=user_id,
        type="tool",
        tool_name="web_file_read",
        metadata={
            "api_key": "sk-secret",
            "password": "x",
            "path": "notes.txt",
        },
    )
    meta = row["metadata"]
    assert "api_key" not in meta
    assert "password" not in meta
    assert meta.get("path") == "notes.txt"


def test_cross_user_logs_isolated(client, mock_upstream_key):
    uid_a, _ = _setup(client, mock_upstream_key, email="ua@example.com")
    track(
        uid_a,
        "chat",
        model="secret-model",
        input_tokens=5,
        output_tokens=5,
        total_tokens=10,
        session_id="a-only",
    )

    client.cookies.clear()
    _uid_b, _ = _setup(client, mock_upstream_key, email="ub@example.com")

    logs = client.get("/api/v1/usage/logs")
    assert logs.status_code == 200
    for item in logs.json()["items"]:
        assert item["user_id"] != uid_a
        assert item.get("session_id") != "a-only"

    summary = client.get("/api/v1/usage/summary")
    assert summary.json()["today"]["tokens"] == 0


def test_post_record_forbidden(client, mock_upstream_key):
    _setup(client, mock_upstream_key, email="forbid@example.com")
    resp = client.post("/api/v1/usage/record", json={"type": "chat"})
    assert resp.status_code == 403


def test_sanitize_metadata_unit():
    cleaned = usage_svc.sanitize_metadata(
        {"authorization": "Bearer x", "ok": 1, "API_KEY": "nope"}
    )
    assert cleaned == {"ok": 1}


def test_skill_track_appears_in_by_skill(client, mock_upstream_key):
    user_id, _ = _setup(client, mock_upstream_key, email="skilluse@example.com")
    track(user_id, "skill", skill_name="demo-skill", tool_name="web_skill_view")
    by_skill = client.get("/api/v1/usage/by-skill")
    assert by_skill.status_code == 200
    names = [r["skill_name"] for r in by_skill.json()["items"]]
    assert "demo-skill" in names
