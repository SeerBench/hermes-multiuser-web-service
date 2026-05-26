"""Tests for the web-chat slash command surface.

Covers both the catalog endpoint ``GET /api/commands`` and the dispatch
endpoint ``POST /api/command``. Critical invariants:

- Catalog excludes ``cli_only`` registry entries and tags the rest as
  ``supported`` / ``client_only``.
- Cross-user access through dispatch (e.g. /title on someone else's
  session) returns 404.
- Pure CLI commands (e.g. /clear when treated as a registry lookup)
  are not reachable through this endpoint.
- /title actually mutates the session row.
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
from gateway.web.web_commands import dispatch as direct_dispatch
from gateway.web.web_commands import list_commands


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


# ── Catalog ──────────────────────────────────────────────────────────────


def test_list_commands_excludes_cli_only():
    """``list_commands`` skips registry entries marked ``cli_only``.
    /clear is intentionally surfaced as a client-only command — it's
    in the curated front-end list, not the registry slice."""
    items = list_commands()
    names = {c["name"] for c in items}
    # /history is cli_only in the registry; it should not appear.
    assert "history" not in names
    # /clear lives in the client-only curated list.
    clear = next((c for c in items if c["name"] == "clear"), None)
    assert clear is not None
    assert clear["client_only"] is True


def test_list_commands_marks_supported_subset():
    items = list_commands()
    title = next(c for c in items if c["name"] == "title")
    assert title["supported"] is True
    assert title["client_only"] is False


def test_list_commands_marks_unsupported_registry_entries():
    items = list_commands()
    # /background is in the registry without cli_only but we don't yet
    # implement it server-side.
    bg = next((c for c in items if c["name"] == "background"), None)
    assert bg is not None
    assert bg["supported"] is False


# ── /api/commands HTTP ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_commands_endpoint_requires_auth(app_with_db):
    resp = await app_with_db.client.get("/api/commands")
    assert resp.status == 401


@pytest.mark.asyncio
async def test_commands_endpoint_returns_catalog(app_with_db, monkeypatch):
    await _login(app_with_db, monkeypatch)
    resp = await app_with_db.client.get("/api/commands")
    assert resp.status == 200
    body = await resp.json()
    names = {c["name"] for c in body["commands"]}
    assert "title" in names
    assert "clear" in names
    assert "history" not in names  # cli_only


# ── /api/command HTTP ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_command_requires_auth(app_with_db):
    resp = await app_with_db.client.post(
        "/api/command", json={"command": "whoami"},
    )
    assert resp.status == 401


@pytest.mark.asyncio
async def test_command_unknown_returns_404(app_with_db, monkeypatch):
    await _login(app_with_db, monkeypatch)
    resp = await app_with_db.client.post(
        "/api/command", json={"command": "nope-does-not-exist"},
    )
    assert resp.status == 404
    body = await resp.json()
    assert body["ok"] is False


@pytest.mark.asyncio
async def test_command_cli_only_returns_405(app_with_db, monkeypatch):
    """A registry command marked cli_only must not be dispatchable here."""
    await _login(app_with_db, monkeypatch)
    resp = await app_with_db.client.post(
        "/api/command", json={"command": "history"},
    )
    assert resp.status == 405


@pytest.mark.asyncio
async def test_command_not_supported_yet_returns_405(app_with_db, monkeypatch):
    """A registry command that's not cli_only but we haven't implemented
    on the web surface (e.g. /background) returns 405."""
    await _login(app_with_db, monkeypatch)
    resp = await app_with_db.client.post(
        "/api/command", json={"command": "background", "args": "do thing"},
    )
    assert resp.status == 405


@pytest.mark.asyncio
async def test_command_client_only_through_server_rejected(
    app_with_db, monkeypatch,
):
    """``/clear`` is meant for the SPA itself; if a request reaches the
    server, the dispatcher tells the caller it shouldn't be here."""
    await _login(app_with_db, monkeypatch)
    resp = await app_with_db.client.post(
        "/api/command", json={"command": "clear"},
    )
    assert resp.status == 400


@pytest.mark.asyncio
async def test_command_whoami_returns_user_id(app_with_db, monkeypatch):
    user_id = await _login(app_with_db, monkeypatch)
    resp = await app_with_db.client.post(
        "/api/command", json={"command": "whoami"},
    )
    assert resp.status == 200
    body = await resp.json()
    assert body["ok"] is True
    assert user_id in body["message"]


@pytest.mark.asyncio
async def test_command_title_sets_session_title(app_with_db, monkeypatch):
    user_id = await _login(app_with_db, monkeypatch)
    # Pre-create a session owned by the logged-in user.
    app_with_db.db.create_session("sess_q", source="web_chat", user_id=user_id)
    resp = await app_with_db.client.post(
        "/api/command",
        json={"command": "title", "args": "My Renamed Session", "session_id": "sess_q"},
    )
    assert resp.status == 200
    # Verify it actually hit the DB.
    sess = app_with_db.db.get_session("sess_q")
    assert sess["title"] == "My Renamed Session"


@pytest.mark.asyncio
async def test_command_title_cross_user_returns_404(app_with_db, monkeypatch):
    app_with_db.db.create_session(
        "sess_alice", source="web_chat", user_id="u_alice_explicit",
    )
    await _login(app_with_db, monkeypatch, api_key="sk-bob")
    resp = await app_with_db.client.post(
        "/api/command",
        json={"command": "title", "args": "hacked", "session_id": "sess_alice"},
    )
    assert resp.status == 404


# ── Direct dispatch (unit-level, no HTTP) ────────────────────────────────


def test_direct_dispatch_whoami_works(app_with_db_factory_hermes_home):
    """Smoke-test the dispatcher without going through HTTP."""
    from hermes_state import SessionDB

    db = SessionDB(app_with_db_factory_hermes_home / "state.db")
    try:
        result = direct_dispatch(
            "whoami", "", user_id="u_test", session_id=None, db=db,
        )
        assert result.ok is True
        assert "u_test" in result.message
    finally:
        db.close()


@pytest.fixture
def app_with_db_factory_hermes_home(tmp_path, monkeypatch):
    home = tmp_path / "hermes_home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home


def test_direct_dispatch_unknown_returns_404(tmp_path, monkeypatch):
    from hermes_state import SessionDB

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    db = SessionDB(tmp_path / "state.db")
    try:
        result = direct_dispatch(
            "totally-fake", "", user_id="u", session_id=None, db=db,
        )
        assert result.ok is False
        assert result.status == 404
    finally:
        db.close()


def test_direct_dispatch_cli_only_returns_405(tmp_path, monkeypatch):
    from hermes_state import SessionDB

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    db = SessionDB(tmp_path / "state.db")
    try:
        result = direct_dispatch(
            "history", "", user_id="u", session_id=None, db=db,
        )
        assert result.ok is False
        assert result.status == 405
    finally:
        db.close()
