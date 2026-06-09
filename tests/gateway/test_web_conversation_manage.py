"""Tests for conversation management endpoints on ``web_chat``.

Covers the sidebar management surface added on top of the read-only
listing:

- ``PATCH  /api/conversations/{id}``         — rename
- ``DELETE /api/conversations/{id}``         — delete
- ``POST   /api/conversations/{id}/flags``   — pin / archive
- ``GET    /api/conversations`` filtering    — archived hidden by default,
                                                pinned sorted first

Ownership masking mirrors ``GET /api/conversations/{id}``: a session owned
by another user is reported as 404 so we never leak its existence.
"""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from gateway.config import PlatformConfig
from gateway.platforms.web_chat import WebChatAdapter
from gateway.web.auth import (
    install_key_vault,
    install_user_store,
    make_auth_middleware,
)
from gateway.web.key_storage import KeyVault
from gateway.web.upstream_validator import ValidationResult
from gateway.web.users import UserStore


@pytest.fixture
def hermes_home(tmp_path, monkeypatch):
    home = tmp_path / "hermes_home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home


@pytest_asyncio.fixture
async def ctx(hermes_home, tmp_path):
    from hermes_state import SessionDB

    config = PlatformConfig(enabled=True)
    adapter = WebChatAdapter(config)
    adapter._new_api_base_url = "https://fake-upstream.example.com"
    adapter._user_store = UserStore(hermes_home / "web_users.db")
    adapter._key_vault = KeyVault(master_key_path=hermes_home / "master.key")
    adapter._runner = MagicMock()
    adapter._session_db = SessionDB(tmp_path / "state.db")
    adapter._agent_semaphore = asyncio.Semaphore(12)

    app = web.Application(middlewares=[make_auth_middleware()])
    install_user_store(app, adapter._user_store)
    install_key_vault(app, adapter._key_vault)
    adapter._wire_routes(app)

    async with TestClient(TestServer(app)) as client:
        yield SimpleNamespace(client=client, adapter=adapter, db=adapter._session_db)
    adapter._session_db.close()
    adapter._user_store.close()


async def _login(ctx, monkeypatch, api_key: str = "sk-good") -> str:
    async def _fake(_api_key, _base_url, **_kw):
        return ValidationResult(valid=True, error_code=None, error_msg=None, status=200)

    monkeypatch.setattr(
        "gateway.platforms.web_chat.validate_key_against_upstream", _fake,
    )
    resp = await ctx.client.post("/api/auth/login", json={"api_key": api_key})
    body = await resp.json()
    return body["user_id"]


def _seed(db, *, session_id: str, user_id: str, messages: list[dict] | None = None) -> None:
    db.create_session(session_id, source="web_chat", user_id=user_id)
    for msg in messages or [{"role": "user", "content": "hi"}]:
        db.append_message(session_id, **msg)


# ── rename ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_rename_requires_auth(ctx):
    resp = await ctx.client.patch("/api/conversations/abc", json={"title": "x"})
    assert resp.status == 401


@pytest.mark.asyncio
async def test_rename_own_session(ctx, monkeypatch):
    user_id = await _login(ctx, monkeypatch)
    _seed(ctx.db, session_id="s1", user_id=user_id)
    resp = await ctx.client.patch("/api/conversations/s1", json={"title": "My chat"})
    assert resp.status == 200
    assert (await resp.json())["title"] == "My chat"
    assert ctx.db.get_session("s1")["title"] == "My chat"


@pytest.mark.asyncio
async def test_rename_empty_title_400(ctx, monkeypatch):
    user_id = await _login(ctx, monkeypatch)
    _seed(ctx.db, session_id="s1", user_id=user_id)
    resp = await ctx.client.patch("/api/conversations/s1", json={"title": "  "})
    assert resp.status == 400


@pytest.mark.asyncio
async def test_rename_other_users_session_404(ctx, monkeypatch):
    _seed(ctx.db, session_id="s_alice", user_id="u_alice_explicit")
    await _login(ctx, monkeypatch, api_key="sk-bob")
    resp = await ctx.client.patch("/api/conversations/s_alice", json={"title": "pwn"})
    assert resp.status == 404
    # Title is untouched.
    assert ctx.db.get_session("s_alice")["title"] in (None, "")


# ── delete ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_delete_own_session(ctx, monkeypatch):
    user_id = await _login(ctx, monkeypatch)
    _seed(ctx.db, session_id="s1", user_id=user_id)
    resp = await ctx.client.delete("/api/conversations/s1")
    assert resp.status == 200
    assert (await resp.json())["deleted"] is True
    assert ctx.db.get_session("s1") is None


@pytest.mark.asyncio
async def test_delete_other_users_session_404(ctx, monkeypatch):
    _seed(ctx.db, session_id="s_alice", user_id="u_alice_explicit")
    await _login(ctx, monkeypatch, api_key="sk-bob")
    resp = await ctx.client.delete("/api/conversations/s_alice")
    assert resp.status == 404
    assert ctx.db.get_session("s_alice") is not None  # still there


@pytest.mark.asyncio
async def test_delete_clears_flags(ctx, monkeypatch):
    user_id = await _login(ctx, monkeypatch)
    _seed(ctx.db, session_id="s1", user_id=user_id)
    ctx.adapter._user_store.set_conversation_flag(user_id, "s1", pinned=True)
    await ctx.client.delete("/api/conversations/s1")
    assert ctx.adapter._user_store.get_conversation_flags(user_id) == {}


# ── flags (pin / archive) ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_flags_requires_auth(ctx):
    resp = await ctx.client.post("/api/conversations/abc/flags", json={"pinned": True})
    assert resp.status == 401


@pytest.mark.asyncio
async def test_flags_other_users_session_404(ctx, monkeypatch):
    _seed(ctx.db, session_id="s_alice", user_id="u_alice_explicit")
    await _login(ctx, monkeypatch, api_key="sk-bob")
    resp = await ctx.client.post(
        "/api/conversations/s_alice/flags", json={"pinned": True},
    )
    assert resp.status == 404


@pytest.mark.asyncio
async def test_flags_empty_body_400(ctx, monkeypatch):
    user_id = await _login(ctx, monkeypatch)
    _seed(ctx.db, session_id="s1", user_id=user_id)
    resp = await ctx.client.post("/api/conversations/s1/flags", json={})
    assert resp.status == 400


@pytest.mark.asyncio
async def test_pin_then_list_sorts_pinned_first(ctx, monkeypatch):
    user_id = await _login(ctx, monkeypatch)
    _seed(ctx.db, session_id="s_old", user_id=user_id)
    time.sleep(0.02)
    _seed(ctx.db, session_id="s_new", user_id=user_id)
    # Without pinning, s_new (more recent) leads.
    resp = await ctx.client.get("/api/conversations")
    ids = [c["id"] for c in (await resp.json())["conversations"]]
    assert ids == ["s_new", "s_old"]
    # Pin the older one — it must jump to the front.
    resp = await ctx.client.post("/api/conversations/s_old/flags", json={"pinned": True})
    assert resp.status == 200
    assert (await resp.json())["pinned"] is True
    resp = await ctx.client.get("/api/conversations")
    convos = (await resp.json())["conversations"]
    assert convos[0]["id"] == "s_old"
    assert convos[0]["pinned"] is True


@pytest.mark.asyncio
async def test_archive_hides_from_default_list(ctx, monkeypatch):
    user_id = await _login(ctx, monkeypatch)
    _seed(ctx.db, session_id="s1", user_id=user_id)
    _seed(ctx.db, session_id="s2", user_id=user_id)
    await ctx.client.post("/api/conversations/s1/flags", json={"archived": True})

    # Default list excludes the archived one.
    resp = await ctx.client.get("/api/conversations")
    ids = [c["id"] for c in (await resp.json())["conversations"]]
    assert ids == ["s2"]

    # ?archived=1 returns only the archived bucket.
    resp = await ctx.client.get("/api/conversations?archived=1")
    archived = (await resp.json())["conversations"]
    assert [c["id"] for c in archived] == ["s1"]
    assert archived[0]["archived"] is True
