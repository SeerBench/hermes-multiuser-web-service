"""Shared fixtures for platform-api tests."""

from __future__ import annotations

import asyncio
import os
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import pytest_asyncio
from pathlib import Path


@pytest.fixture()
def platform_env(tmp_path, monkeypatch):
    """Hermetic PLATFORM_DATABASE_URL + HERMES_HOME for platform tests."""
    home = tmp_path / ".hermes"
    home.mkdir()
    db_path = tmp_path / "platform.db"
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("PLATFORM_DATABASE_URL", f"sqlite:///{db_path}")
    monkeypatch.setenv("UPSTREAM_PROVISIONER", "manual")
    monkeypatch.setenv("NEW_API_BASE_URL", "http://upstream.test")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    # Clear FastAPI dependency caches between tests.
    from platform_api import deps

    deps.get_settings.cache_clear()
    deps.get_store.cache_clear()
    deps.get_vault.cache_clear()
    from platform_api.services.rate_limit import reset_login_rate_limiter_for_tests

    reset_login_rate_limiter_for_tests()
    from platform_api.services.mail import reset_mailer_for_tests

    reset_mailer_for_tests()
    yield db_path
    deps.get_settings.cache_clear()
    deps.get_store.cache_clear()
    deps.get_vault.cache_clear()
    reset_login_rate_limiter_for_tests()
    reset_mailer_for_tests()


@pytest.fixture()
def client(platform_env):
    from fastapi.testclient import TestClient
    from platform_api.main import app

    return TestClient(app)


@pytest.fixture()
def mock_upstream_key(monkeypatch):
    """Stub upstream key validation (sync + async paths)."""
    from gateway.web.upstream_validator import ValidationResult

    class _SyncResult:
        valid = True
        error_msg = None
        error_code = None
        status = 200

    monkeypatch.setattr(
        "gateway.web.upstream_validator.validate_key_against_upstream_sync",
        lambda *a, **k: _SyncResult(),
    )

    async def _async_valid(api_key, base_url, **kw):
        return ValidationResult(
            valid=True, error_code=None, error_msg=None, status=200,
        )

    monkeypatch.setattr(
        "gateway.platforms.web_chat.validate_key_against_upstream",
        _async_valid,
    )


def register_user(client, email: str = "user@example.com", password: str = "password123"):
    """Register via platform API; returns response JSON + session cookie."""
    resp = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password},
    )
    assert resp.status_code == 200, resp.text
    cookie = resp.cookies.get("hermes_session")
    assert cookie
    return resp.json(), cookie


def bind_upstream_key(client, api_key: str = "sk-test-key-12345678"):
    """Bind upstream key after register; returns new cookie."""
    resp = client.post("/api/v1/auth/bind-key", json={"api_key": api_key})
    assert resp.status_code == 200, resp.text
    cookie = resp.cookies.get("hermes_session")
    assert cookie
    return resp.json(), cookie


def set_gateway_cookie(gateway_client, session_token: str) -> None:
    """Attach platform session cookie to aiohttp TestClient."""
    # Must match TestServer host (127.0.0.1), not localhost — otherwise jar ignores it.
    base = gateway_client.make_url("/")
    gateway_client.session.cookie_jar.update_cookies(
        {"hermes_session": session_token},
        base,
    )


@pytest_asyncio.fixture
async def gateway(platform_env, tmp_path):
    """Agent Gateway (web_chat) wired to the same PlatformStore as platform-api."""
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    from hermes_state import SessionDB

    from gateway.config import PlatformConfig
    from gateway.platforms.web_chat import WebChatAdapter
    from gateway.web.auth import (
        install_key_vault,
        install_user_store,
        make_auth_middleware,
    )
    from platform_api.deps import get_store, get_vault

    config = PlatformConfig(enabled=True)
    adapter = WebChatAdapter(config)
    adapter._new_api_base_url = os.environ.get("NEW_API_BASE_URL", "http://upstream.test")
    adapter._user_store = get_store()
    adapter._key_vault = get_vault()
    adapter._runner = MagicMock()
    adapter._session_db = SessionDB(tmp_path / "state.db")
    adapter._agent_semaphore = asyncio.Semaphore(12)

    app = web.Application(middlewares=[make_auth_middleware()])
    install_user_store(app, adapter._user_store)
    install_key_vault(app, adapter._key_vault)
    adapter._wire_routes(app)

    async with TestClient(TestServer(app)) as http_client:
        yield SimpleNamespace(
            client=http_client,
            adapter=adapter,
            db=adapter._session_db,
        )
    adapter._session_db.close()
