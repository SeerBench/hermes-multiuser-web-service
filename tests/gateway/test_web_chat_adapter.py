"""HTTP-surface tests for :class:`gateway.platforms.web_chat.WebChatAdapter`.

Drives the routes end-to-end against a real aiohttp ``TestClient``,
but two things are stubbed to keep the suite hermetic:

- :func:`gateway.web.upstream_validator.validate_key_against_upstream`
  is mocked so the tests don't reach the network.
- :class:`gateway.web.chat_runner.WebChatAgentRunner` is replaced with
  a ``MagicMock`` — exercising the real agent would pull the entire
  Hermes provider tree.  We only verify wiring (auth gate, cookie
  issuance, /api/me, /api/conversations).

The auth middleware, UserStore, KeyVault, and upstream_key contextvar
binding are all real — these tests exercise the same code paths a
browser would hit during login + first chat turn.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from gateway.config import Platform, PlatformConfig
from gateway.platforms.web_chat import WebChatAdapter
from gateway.web.auth import (
    SESSION_COOKIE,
    install_key_vault,
    install_user_store,
    make_auth_middleware,
)
from gateway.web.key_storage import KeyVault
from gateway.web.upstream_validator import ValidationResult
from gateway.web.users import UserStore


@pytest.fixture
def hermes_home(tmp_path, monkeypatch):
    """Redirect HERMES_HOME so UserStore + workspaces land in tmp_path."""
    home = tmp_path / "hermes_home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home


@pytest_asyncio.fixture
async def adapter_app(hermes_home):
    """Construct an adapter + aiohttp client without actually binding
    a socket.  Mirrors WebChatAdapter.connect() wiring but skips the
    TCPSite startup.
    """
    config = PlatformConfig(enabled=True)
    adapter = WebChatAdapter(config)
    adapter._new_api_base_url = "https://fake-upstream.example.com"
    adapter._user_store = UserStore(hermes_home / "web_users.db")
    adapter._key_vault = KeyVault(master_key_path=hermes_home / "master.key")
    adapter._runner = MagicMock()
    adapter._session_db = None
    adapter._agent_semaphore = asyncio.Semaphore(12)

    app = web.Application(middlewares=[make_auth_middleware()])
    install_user_store(app, adapter._user_store)
    install_key_vault(app, adapter._key_vault)
    adapter._wire_routes(app)

    async with TestClient(TestServer(app)) as client:
        yield SimpleNamespace(
            client=client,
            adapter=adapter,
            store=adapter._user_store,
            vault=adapter._key_vault,
        )
    adapter._user_store.close()


async def _patch_validator(monkeypatch, *, valid: bool, error_code: str | None = None):
    """Stub validate_key_against_upstream to return a synthetic result."""
    async def _fake(api_key, base_url, **kw):
        return ValidationResult(
            valid=valid,
            error_code=error_code,
            error_msg=None,
            status=200 if valid else 401,
        )
    monkeypatch.setattr(
        "gateway.platforms.web_chat.validate_key_against_upstream",
        _fake,
    )


# ── /api/healthz ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_healthz_returns_ok(adapter_app):
    resp = await adapter_app.client.get("/api/healthz")
    assert resp.status == 200
    body = await resp.json()
    assert body["status"] == "ok"
    assert body["platform"] == "web_chat"


# ── SPA shell ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_root_serves_spa_shell_unauthenticated(adapter_app):
    """First-screen must not require auth — the SPA needs to load
    before the user is prompted for a key.  Whether ``/`` returns the
    placeholder HTML (source checkout) or the built SPA bundle
    (deployment) is incidental; both are HTML, neither is 401.
    """
    resp = await adapter_app.client.get("/")
    assert resp.status == 200
    assert "text/html" in resp.headers.get("Content-Type", "")


# ── /api/auth/login ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_login_with_valid_key_sets_cookie(adapter_app, monkeypatch):
    await _patch_validator(monkeypatch, valid=True)
    resp = await adapter_app.client.post(
        "/api/auth/login", json={"api_key": "sk-good-key"},
    )
    assert resp.status == 200
    body = await resp.json()
    assert body["user_id"].startswith("u_")
    # Cookie issued.
    assert SESSION_COOKIE in resp.cookies


@pytest.mark.asyncio
async def test_login_persists_user_row(adapter_app, monkeypatch):
    await _patch_validator(monkeypatch, valid=True)
    resp = await adapter_app.client.post(
        "/api/auth/login", json={"api_key": "sk-good-key"},
    )
    body = await resp.json()
    user_id = body["user_id"]
    assert adapter_app.store.get_user(user_id) is not None


@pytest.mark.asyncio
async def test_login_with_invalid_key_returns_401(adapter_app, monkeypatch):
    await _patch_validator(monkeypatch, valid=False, error_code="invalid_key")
    resp = await adapter_app.client.post(
        "/api/auth/login", json={"api_key": "sk-bad-key"},
    )
    assert resp.status == 401
    body = await resp.json()
    assert body["code"] == "invalid_key"


@pytest.mark.asyncio
async def test_login_with_unreachable_upstream_returns_503(adapter_app, monkeypatch):
    await _patch_validator(monkeypatch, valid=False, error_code="upstream_unreachable")
    resp = await adapter_app.client.post(
        "/api/auth/login", json={"api_key": "sk-anything"},
    )
    assert resp.status == 503
    body = await resp.json()
    assert body["code"] == "upstream_unreachable"


@pytest.mark.asyncio
async def test_login_with_misconfigured_upstream_returns_502(adapter_app, monkeypatch):
    await _patch_validator(monkeypatch, valid=False, error_code="misconfigured")
    resp = await adapter_app.client.post(
        "/api/auth/login", json={"api_key": "sk-anything"},
    )
    assert resp.status == 502
    body = await resp.json()
    assert body["code"] == "misconfigured"


@pytest.mark.asyncio
async def test_login_with_missing_api_key_returns_400(adapter_app):
    resp = await adapter_app.client.post("/api/auth/login", json={})
    assert resp.status == 400
    body = await resp.json()
    assert body["code"] == "missing_api_key"


@pytest.mark.asyncio
async def test_same_key_in_two_logins_yields_same_user_id(adapter_app, monkeypatch):
    """Two browsers logging in with the same key see the same user_id —
    deterministic derivation is what makes cross-device history work.
    """
    await _patch_validator(monkeypatch, valid=True)
    r1 = await adapter_app.client.post("/api/auth/login", json={"api_key": "sk-shared"})
    adapter_app.client.session.cookie_jar.clear()
    r2 = await adapter_app.client.post("/api/auth/login", json={"api_key": "sk-shared"})
    body1 = await r1.json()
    body2 = await r2.json()
    assert body1["user_id"] == body2["user_id"]


# ── /api/auth/logout ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_logout_clears_cookie_and_invalidates_session(adapter_app, monkeypatch):
    await _patch_validator(monkeypatch, valid=True)
    await adapter_app.client.post("/api/auth/login", json={"api_key": "sk-good"})

    resp = await adapter_app.client.post("/api/auth/logout")
    assert resp.status == 200

    # After logout, /api/me should 401.
    me = await adapter_app.client.get("/api/me")
    assert me.status == 401


# ── /api/me ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_me_requires_auth(adapter_app):
    resp = await adapter_app.client.get("/api/me")
    assert resp.status == 401


@pytest.mark.asyncio
async def test_me_returns_user_id_after_login(adapter_app, monkeypatch):
    await _patch_validator(monkeypatch, valid=True)
    login = await adapter_app.client.post(
        "/api/auth/login", json={"api_key": "sk-good"},
    )
    login_body = await login.json()

    me = await adapter_app.client.get("/api/me")
    assert me.status == 200
    body = await me.json()
    assert body["user_id"] == login_body["user_id"]
    assert "created_at" in body
    assert "last_seen_at" in body


# ── /api/conversations ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_conversations_requires_auth(adapter_app):
    resp = await adapter_app.client.get("/api/conversations")
    assert resp.status == 401


@pytest.mark.asyncio
async def test_conversations_returns_empty_without_session_db(adapter_app, monkeypatch):
    await _patch_validator(monkeypatch, valid=True)
    await adapter_app.client.post("/api/auth/login", json={"api_key": "sk-good"})

    resp = await adapter_app.client.get("/api/conversations")
    assert resp.status == 200
    body = await resp.json()
    assert body == {"conversations": []}


# ── /api/chat (auth-only check; runner is mocked) ──────────────────────────


@pytest.mark.asyncio
async def test_chat_requires_auth(adapter_app):
    resp = await adapter_app.client.post("/api/chat", json={"message": "hi"})
    assert resp.status == 401


@pytest.mark.asyncio
async def test_chat_with_no_message_returns_400(adapter_app, monkeypatch):
    await _patch_validator(monkeypatch, valid=True)
    await adapter_app.client.post("/api/auth/login", json={"api_key": "sk-good"})

    resp = await adapter_app.client.post("/api/chat", json={})
    assert resp.status == 400


@pytest.mark.asyncio
async def test_chat_failed_run_emits_sse_error_event(adapter_app, monkeypatch):
    """When the agent loop returns ``failed: True`` (HTTP 401 from the
    upstream LLM gateway, billing-blocked accounts, …), the chat
    handler must surface that as an SSE ``error`` event with the
    underlying message — otherwise the SPA's assistant turn is stuck
    on "…" forever with no indication of what went wrong.
    """
    await _patch_validator(monkeypatch, valid=True)
    await adapter_app.client.post("/api/auth/login", json={"api_key": "sk-good"})

    async def _fail(**kw):
        return (
            {"final_response": None, "failed": True, "error": "HTTP 401: Invalid token"},
            {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0},
        )

    adapter_app.adapter._runner.run = _fail

    resp = await adapter_app.client.post(
        "/api/chat", json={"message": "hi"},
    )
    assert resp.status == 200
    text = await resp.text()
    assert "event: error" in text
    assert "Invalid token" in text
    assert "agent_error" in text
    # Must NOT also emit a terminal ``done`` event — the SPA treats
    # ``done`` as success and would clear the error indicator.
    assert "event: done" not in text


@pytest.mark.asyncio
async def test_chat_successful_run_emits_done(adapter_app, monkeypatch):
    """Sanity counterpart to the failed-run test: a non-failed result
    still emits ``done`` (not ``error``).
    """
    await _patch_validator(monkeypatch, valid=True)
    await adapter_app.client.post("/api/auth/login", json={"api_key": "sk-good"})

    async def _ok(**kw):
        return (
            {"final_response": "hi back", "session_id": "s_xyz"},
            {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
        )

    adapter_app.adapter._runner.run = _ok

    resp = await adapter_app.client.post(
        "/api/chat", json={"message": "hi"},
    )
    assert resp.status == 200
    text = await resp.text()
    assert "event: done" in text
    assert "event: error" not in text


@pytest.mark.asyncio
async def test_chat_emits_status_step_activity_events(adapter_app, monkeypatch):
    """The chat handler must forward the agent's status_callback /
    step_callback / tool_progress_callback into SSE ``status`` / ``step`` /
    ``activity`` events so the SPA can show what's happening behind the
    scenes.  We fake a runner that fires those callbacks mid-turn.
    """
    await _patch_validator(monkeypatch, valid=True)
    await adapter_app.client.post("/api/auth/login", json={"api_key": "sk-good"})

    async def _run(**kw):
        # Fire the activity callbacks the way the real agent would, then
        # yield so the SSE writer drains them before the turn finishes.
        kw["status_callback"]("warn", "🗜️ compressing context")
        kw["step_callback"](2, [{"name": "web_search"}])
        kw["tool_progress_callback"]("_thinking", "deciding what to do next")
        await asyncio.sleep(0.02)
        return (
            {"final_response": "done", "session_id": "s_act"},
            {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
        )

    adapter_app.adapter._runner.run = _run

    resp = await adapter_app.client.post("/api/chat", json={"message": "hi"})
    assert resp.status == 200
    text = await resp.text()
    assert "event: status" in text
    assert "compressing context" in text
    assert "event: step" in text
    assert "web_search" in text
    assert "event: activity" in text
    assert "deciding what to do next" in text
    assert "event: done" in text
