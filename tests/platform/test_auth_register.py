"""Platform auth: register, login, bind-key, me."""

from __future__ import annotations

from unittest.mock import patch

from gateway.web.platform.store import PlatformStore
from platform_api.deps import get_store


def test_register_login_me_flow(client):
    reg = client.post(
        "/api/v1/auth/register",
        json={"email": "alice@example.com", "password": "password123"},
    )
    assert reg.status_code == 200, reg.text
    body = reg.json()
    assert body["user"]["email"] == "alice@example.com"
    assert body["upstream_status"] == "pending_bind"
    assert "hermes_session" in reg.cookies

    me = client.get("/api/v1/auth/me")
    assert me.status_code == 200
    assert me.json()["email"] == "alice@example.com"

    client.post("/api/v1/auth/logout")
    me2 = client.get("/api/v1/auth/me")
    assert me2.status_code == 401

    login = client.post(
        "/api/v1/auth/login",
        json={"email": "alice@example.com", "password": "password123"},
    )
    assert login.status_code == 200
    assert login.cookies.get("hermes_session")


def test_register_duplicate_email(client):
    payload = {"email": "bob@example.com", "password": "password123"}
    assert client.post("/api/v1/auth/register", json=payload).status_code == 200
    dup = client.post("/api/v1/auth/register", json=payload)
    assert dup.status_code == 400


def test_bind_key_updates_upstream_status(client, monkeypatch):
    client.post(
        "/api/v1/auth/register",
        json={"email": "carol@example.com", "password": "password123"},
    )

    class _Result:
        valid = True
        error_msg = None

    monkeypatch.setattr(
        "gateway.web.upstream_validator.validate_key_against_upstream_sync",
        lambda *a, **k: _Result(),
    )

    resp = client.post(
        "/api/v1/auth/bind-key",
        json={"api_key": "sk-test-key-12345678"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["upstream_status"] == "ready"

    store = get_store()
    assert isinstance(store, PlatformStore)
    enc = store.get_user_upstream_key_enc(resp.json()["user"]["user_id"])
    assert enc
