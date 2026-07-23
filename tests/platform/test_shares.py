"""Share snapshots: create (auth) + public read-only GET."""

from __future__ import annotations

from tests.platform.conftest import register_user


def _login(client, email: str = "share@example.com"):
    body, _ = register_user(client, email=email)
    return body["user"]["user_id"]


def test_create_share_and_anonymous_get(client):
    _login(client)
    create = client.post(
        "/api/v1/shares",
        json={
            "kind": "reply",
            "title": "Demo reply",
            "turns": [{"role": "assistant", "text": "Hello from Hermes"}],
            "source_session_id": "sess-demo",
        },
    )
    assert create.status_code == 200, create.text
    data = create.json()
    assert data["token"]
    assert data["url_path"] == f"#/share/{data['token']}"

    # Anonymous visitor — clear cookies
    client.cookies.clear()
    got = client.get(f"/api/v1/shares/{data['token']}")
    assert got.status_code == 200, got.text
    payload = got.json()
    assert payload["kind"] == "reply"
    assert payload["title"] == "Demo reply"
    assert payload["turns"] == [{"role": "assistant", "text": "Hello from Hermes"}]
    assert "owner_user_id" not in payload
    assert "source_session_id" not in payload


def test_create_conversation_share(client):
    _login(client, email="conv-share@example.com")
    create = client.post(
        "/api/v1/shares",
        json={
            "kind": "conversation",
            "title": "My chat",
            "turns": [
                {"role": "user", "text": "Hi"},
                {"role": "assistant", "text": "Hello"},
            ],
        },
    )
    assert create.status_code == 200, create.text
    token = create.json()["token"]
    client.cookies.clear()
    got = client.get(f"/api/v1/shares/{token}")
    assert got.status_code == 200
    body = got.json()
    assert body["kind"] == "conversation"
    assert len(body["turns"]) == 2


def test_create_share_requires_auth(client):
    resp = client.post(
        "/api/v1/shares",
        json={
            "kind": "reply",
            "turns": [{"role": "assistant", "text": "x"}],
        },
    )
    assert resp.status_code == 401


def test_get_unknown_token_404(client):
    resp = client.get("/api/v1/shares/not-a-real-token-zzzz")
    assert resp.status_code == 404


def test_create_rejects_empty_turns(client):
    _login(client, email="empty-share@example.com")
    resp = client.post(
        "/api/v1/shares",
        json={"kind": "reply", "turns": []},
    )
    assert resp.status_code == 422


def test_create_rejects_invalid_role(client):
    _login(client, email="badrole@example.com")
    resp = client.post(
        "/api/v1/shares",
        json={
            "kind": "reply",
            "turns": [{"role": "system", "text": "nope"}],
        },
    )
    assert resp.status_code == 422


def test_snapshot_immutable_after_create(client):
    """Public GET returns the frozen payload; there is no update API."""
    _login(client, email="immut@example.com")
    create = client.post(
        "/api/v1/shares",
        json={
            "kind": "reply",
            "turns": [{"role": "assistant", "text": "frozen"}],
        },
    )
    token = create.json()["token"]
    # No PATCH/PUT endpoint — only GET
    assert client.patch(f"/api/v1/shares/{token}", json={}).status_code in (404, 405)
    assert client.put(f"/api/v1/shares/{token}", json={}).status_code in (404, 405)
    client.cookies.clear()
    got = client.get(f"/api/v1/shares/{token}")
    assert got.json()["turns"][0]["text"] == "frozen"
