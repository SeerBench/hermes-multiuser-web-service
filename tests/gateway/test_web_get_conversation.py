"""Tests for ``GET /api/conversations/{conversation_id}``.

This is the endpoint that backs the sidebar "click to reopen" flow.
Critical invariants:

- Anonymous requests get 401 (auth middleware).
- A session owned by another user appears as 404 — never leak even the
  existence of someone else's session id.
- A real session for the logged-in user round-trips its messages with
  roles, content, and tool_calls intact.
"""

from __future__ import annotations

import asyncio
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
async def app_with_db(hermes_home, tmp_path):
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
        yield SimpleNamespace(
            client=client,
            adapter=adapter,
            db=adapter._session_db,
        )
    adapter._session_db.close()
    adapter._user_store.close()


async def _login(ctx, monkeypatch, api_key: str = "sk-good") -> str:
    async def _fake(_api_key, _base_url, **_kw):
        return ValidationResult(
            valid=True, error_code=None, error_msg=None, status=200,
        )

    monkeypatch.setattr(
        "gateway.platforms.web_chat.validate_key_against_upstream", _fake,
    )
    resp = await ctx.client.post("/api/auth/login", json={"api_key": api_key})
    body = await resp.json()
    return body["user_id"]


def _seed(db, *, session_id: str, user_id: str, messages: list[dict]) -> None:
    db.create_session(session_id, source="web_chat", user_id=user_id)
    for msg in messages:
        db.append_message(session_id, **msg)


# ── Auth ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_conversation_requires_auth(app_with_db):
    resp = await app_with_db.client.get("/api/conversations/abc")
    assert resp.status == 401


# ── Not found / cross-user ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_conversation_unknown_returns_404(app_with_db, monkeypatch):
    await _login(app_with_db, monkeypatch)
    resp = await app_with_db.client.get("/api/conversations/never-existed")
    assert resp.status == 404
    body = await resp.json()
    assert body["code"] == "not_found"


@pytest.mark.asyncio
async def test_get_conversation_other_users_session_returns_404(
    app_with_db, monkeypatch,
):
    # Seed a conversation owned by user A (fixed user_id, not derived).
    _seed(
        app_with_db.db,
        session_id="sess_alice",
        user_id="u_alice_explicit",
        messages=[{"role": "user", "content": "hi"}],
    )
    # Log in as someone else.
    await _login(app_with_db, monkeypatch, api_key="sk-bob")
    resp = await app_with_db.client.get("/api/conversations/sess_alice")
    assert resp.status == 404


# ── Happy path ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_conversation_returns_messages(app_with_db, monkeypatch):
    user_id = await _login(app_with_db, monkeypatch)
    _seed(
        app_with_db.db,
        session_id="sess_x",
        user_id=user_id,
        messages=[
            {"role": "user", "content": "what is 2+2?"},
            {"role": "assistant", "content": "4"},
        ],
    )
    resp = await app_with_db.client.get("/api/conversations/sess_x")
    assert resp.status == 200
    body = await resp.json()
    assert body["id"] == "sess_x"
    assert len(body["messages"]) == 2
    assert body["messages"][0]["role"] == "user"
    assert body["messages"][0]["content"] == "what is 2+2?"
    assert body["messages"][1]["role"] == "assistant"
    assert body["messages"][1]["content"] == "4"


@pytest.mark.asyncio
async def test_get_conversation_preserves_tool_calls(app_with_db, monkeypatch):
    user_id = await _login(app_with_db, monkeypatch)
    tool_calls = [
        {
            "id": "tc_search_1",
            "type": "function",
            "function": {"name": "search", "arguments": "{\"q\":\"hermes\"}"},
        }
    ]
    _seed(
        app_with_db.db,
        session_id="sess_t",
        user_id=user_id,
        messages=[
            {"role": "user", "content": "find docs"},
            {
                "role": "assistant",
                "content": "looking…",
                "tool_calls": tool_calls,
            },
            {
                "role": "tool",
                "tool_call_id": "tc_search_1",
                "tool_name": "search",
                "content": "found it",
            },
        ],
    )
    resp = await app_with_db.client.get("/api/conversations/sess_t")
    body = await resp.json()
    roles = [m["role"] for m in body["messages"]]
    assert roles == ["user", "assistant", "tool"]
    assistant = body["messages"][1]
    assert assistant["tool_calls"]
    assert assistant["tool_calls"][0]["function"]["name"] == "search"
    tool_row = body["messages"][2]
    assert tool_row["tool_call_id"] == "tc_search_1"
    assert tool_row["content"] == "found it"


@pytest.mark.asyncio
async def test_get_conversation_preserves_reasoning(app_with_db, monkeypatch):
    user_id = await _login(app_with_db, monkeypatch)
    _seed(
        app_with_db.db,
        session_id="sess_r",
        user_id=user_id,
        messages=[
            {"role": "user", "content": "puzzle"},
            {
                "role": "assistant",
                "content": "answer",
                "reasoning": "step 1, step 2, step 3",
            },
        ],
    )
    resp = await app_with_db.client.get("/api/conversations/sess_r")
    body = await resp.json()
    assistant = body["messages"][1]
    assert assistant["reasoning"] == "step 1, step 2, step 3"


@pytest.mark.asyncio
async def test_get_conversation_empty_session(app_with_db, monkeypatch):
    user_id = await _login(app_with_db, monkeypatch)
    _seed(app_with_db.db, session_id="sess_empty", user_id=user_id, messages=[])
    resp = await app_with_db.client.get("/api/conversations/sess_empty")
    assert resp.status == 200
    body = await resp.json()
    assert body["messages"] == []


@pytest.mark.asyncio
async def test_get_conversation_blank_id_returns_400(app_with_db, monkeypatch):
    await _login(app_with_db, monkeypatch)
    # Path-encoded blank: aiohttp normalises //, so we test with a
    # whitespace-only id instead.
    resp = await app_with_db.client.get("/api/conversations/%20")
    assert resp.status in (400, 404)
