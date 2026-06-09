"""Tests for ``POST /api/uploads`` on the ``web_chat`` platform.

Files land in the per-user sandbox workspace under ``uploads/`` and are
read on demand by the agent via ``web_file_read``.  Invariants:

- Anonymous requests get 401.
- An uploaded file is written inside ``<workspace>/uploads/`` and the
  response reports a workspace-relative ``uploads/<name>`` path — never an
  absolute host path.
- A hostile filename (path traversal) is reduced to a safe basename that
  still lands inside the sandbox.
- A second upload of the same name does not clobber the first.
- Files over the per-file cap are rejected with 413.
- Non-multipart bodies are rejected with 400.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import pytest_asyncio
from aiohttp import FormData, web
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
        yield SimpleNamespace(
            client=client, adapter=adapter, home=hermes_home,
        )
    adapter._session_db.close()
    adapter._user_store.close()


async def _login(ctx, monkeypatch, api_key: str = "sk-good") -> str:
    async def _fake(_api_key, _base_url, **_kw):
        return ValidationResult(valid=True, error_code=None, error_msg=None, status=200)

    monkeypatch.setattr(
        "gateway.platforms.web_chat.validate_key_against_upstream", _fake,
    )
    resp = await ctx.client.post("/api/auth/login", json={"api_key": api_key})
    return (await resp.json())["user_id"]


def _form(filename: str, content: bytes, *, field: str = "files") -> FormData:
    data = FormData()
    data.add_field(field, content, filename=filename, content_type="text/plain")
    return data


def _uploads_dir(ctx, user_id):
    return ctx.home / "web_workspaces" / user_id / "uploads"


# ── auth ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_upload_requires_auth(ctx):
    resp = await ctx.client.post("/api/uploads", data=_form("a.txt", b"hi"))
    assert resp.status == 401


# ── happy path ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_upload_lands_in_sandbox(ctx, monkeypatch):
    user_id = await _login(ctx, monkeypatch)
    resp = await ctx.client.post("/api/uploads", data=_form("note.txt", b"hello world"))
    assert resp.status == 200
    files = (await resp.json())["files"]
    assert len(files) == 1
    assert files[0]["path"] == "uploads/note.txt"
    assert files[0]["name"] == "note.txt"
    assert files[0]["size"] == len(b"hello world")
    # Never leak an absolute host path.
    assert not files[0]["path"].startswith("/")
    on_disk = _uploads_dir(ctx, user_id) / "note.txt"
    assert on_disk.is_file()
    assert on_disk.read_bytes() == b"hello world"


@pytest.mark.asyncio
async def test_upload_hostile_name_stays_in_sandbox(ctx, monkeypatch):
    user_id = await _login(ctx, monkeypatch)
    resp = await ctx.client.post(
        "/api/uploads", data=_form("../../etc/passwd", b"root:x:0:0:"),
    )
    assert resp.status == 200
    files = (await resp.json())["files"]
    # Whatever the sanitized name is, it lands inside uploads/ and never
    # escapes — confine_path is the authoritative guard.
    assert files[0]["path"].startswith("uploads/")
    assert "/" not in files[0]["name"]
    up = _uploads_dir(ctx, user_id)
    written = up / files[0]["name"]
    assert written.resolve().is_relative_to(up.resolve())
    assert written.is_file()
    # No passwd file leaked outside the workspace.
    assert not (ctx.home / "web_workspaces" / user_id / ".." / "etc").exists()


# ── filename sanitizer (unit) ────────────────────────────────────────────────


def test_sanitize_strips_path_components():
    from gateway.platforms.web_chat import _sanitize_upload_name

    assert _sanitize_upload_name("../../etc/passwd") == "passwd"
    assert _sanitize_upload_name("a/b/c.txt") == "c.txt"
    assert _sanitize_upload_name("C:\\Users\\x\\f.txt") == "f.txt"


def test_sanitize_strips_leading_dots_and_empty_fallback():
    from gateway.platforms.web_chat import _sanitize_upload_name

    assert _sanitize_upload_name("...hidden") == "hidden"
    assert _sanitize_upload_name("..") == "file"
    assert _sanitize_upload_name("") == "file"
    assert _sanitize_upload_name("///") == "file"


def test_sanitize_collapses_unsafe_chars_keeps_extension():
    from gateway.platforms.web_chat import _sanitize_upload_name

    out = _sanitize_upload_name("we!rd@na#me.txt")
    assert all(c not in out for c in "!@#")
    assert out.endswith(".txt")


@pytest.mark.asyncio
async def test_upload_dedupes_same_name(ctx, monkeypatch):
    user_id = await _login(ctx, monkeypatch)
    await ctx.client.post("/api/uploads", data=_form("data.csv", b"a,b,c"))
    resp = await ctx.client.post("/api/uploads", data=_form("data.csv", b"d,e,f"))
    files = (await resp.json())["files"]
    assert files[0]["path"] == "uploads/data-1.csv"
    up = _uploads_dir(ctx, user_id)
    assert (up / "data.csv").read_bytes() == b"a,b,c"
    assert (up / "data-1.csv").read_bytes() == b"d,e,f"


@pytest.mark.asyncio
async def test_upload_too_large_413(ctx, monkeypatch):
    await _login(ctx, monkeypatch)
    # Shrink the cap so the test stays cheap.
    monkeypatch.setattr(
        "gateway.platforms.web_chat._UPLOAD_MAX_FILE_BYTES", 8, raising=True,
    )
    resp = await ctx.client.post(
        "/api/uploads", data=_form("big.txt", b"way too many bytes"),
    )
    assert resp.status == 413
    assert (await resp.json())["code"] == "file_too_large"


@pytest.mark.asyncio
async def test_upload_rejects_non_multipart(ctx, monkeypatch):
    await _login(ctx, monkeypatch)
    resp = await ctx.client.post("/api/uploads", json={"not": "multipart"})
    assert resp.status == 400
