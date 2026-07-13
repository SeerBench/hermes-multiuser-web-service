"""Platform login → Agent Gateway chat SSE (shared platform_sessions cookie)."""

from __future__ import annotations

import pytest

from tests.platform.conftest import (
    bind_upstream_key,
    register_user,
    set_gateway_cookie,
)


@pytest.mark.asyncio
async def test_platform_session_rejected_for_chat_without_bind(
    client, gateway, mock_upstream_key,
):
    """pending_bind users must bind upstream key before POST /api/chat."""
    _body, cookie = register_user(client, email="pending@example.com")
    assert _body["upstream_status"] == "pending_bind"

    set_gateway_cookie(gateway.client, cookie)
    me = await gateway.client.get("/api/me")
    assert me.status == 200
    me_body = await me.json()
    assert me_body["upstream_status"] == "pending_bind"

    chat = await gateway.client.post("/api/chat", json={"message": "hello"})
    assert chat.status == 403
    err = await chat.json()
    assert err["code"] == "upstream_key_required"


@pytest.mark.asyncio
async def test_platform_register_bind_chat_emits_sse_done(
    client, gateway, mock_upstream_key,
):
    """Full path: register → bind-key → /api/me → /api/chat SSE done."""
    reg_body, _cookie = register_user(client, email="e2e@example.com")
    user_id = reg_body["user"]["user_id"]

    bind_body, cookie = bind_upstream_key(client)
    assert bind_body["upstream_status"] == "ready"

    set_gateway_cookie(gateway.client, cookie)

    me = await gateway.client.get("/api/me")
    assert me.status == 200
    me_body = await me.json()
    assert me_body["user_id"] == user_id
    assert me_body["email"] == "e2e@example.com"
    assert me_body["upstream_status"] == "ready"

    async def _ok_run(**kw):
        return (
            {"final_response": "hello back", "session_id": "sess_e2e"},
            {"input_tokens": 3, "output_tokens": 5, "total_tokens": 8},
        )

    gateway.adapter._runner.run = _ok_run

    chat = await gateway.client.post("/api/chat", json={"message": "hi there"})
    assert chat.status == 200
    text = await chat.text()
    assert "event: done" in text
    assert "sess_e2e" in text
    assert "event: error" not in text


@pytest.mark.asyncio
async def test_platform_login_reuses_session_on_gateway(
    client, gateway, mock_upstream_key,
):
    """Logout + login round-trip keeps a valid gateway cookie."""
    register_user(client, email="roundtrip@example.com")
    bind_upstream_key(client)
    client.post("/api/v1/auth/logout")

    login = client.post(
        "/api/v1/auth/login",
        json={"email": "roundtrip@example.com", "password": "password123"},
    )
    assert login.status_code == 200
    cookie = login.cookies.get("hermes_session")
    assert cookie

    set_gateway_cookie(gateway.client, cookie)
    convos = await gateway.client.get("/api/conversations")
    assert convos.status == 200
    body = await convos.json()
    assert body == {"conversations": []}
