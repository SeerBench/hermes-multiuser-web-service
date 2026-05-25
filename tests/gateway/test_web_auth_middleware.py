"""Tests for ``gateway.web.auth`` — cookie + Bearer middleware.

Covers the contract:

- Whitelisted paths (login, register, healthz, static assets, SPA shell)
  pass through without auth.
- ``OPTIONS`` preflight always passes (CORS).
- Valid cookie → handler sees ``request["user_id"]``.
- Valid Bearer → handler sees ``request["user_id"]``.
- Cookie takes precedence; falls back to Bearer if cookie invalid.
- Both invalid / missing → ``401``.
- Disabled user → ``401``.
- Missing UserStore on the app → ``500`` (server config bug).
"""

from types import SimpleNamespace

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from gateway.web.auth import (
    SESSION_COOKIE,
    USER_ID_REQUEST_KEY,
    install_user_store,
    issue_session_cookie,
    make_auth_middleware,
)
from gateway.web.users import UserStore


def _build_app(store: UserStore | None) -> web.Application:
    """Construct the test app with the auth middleware and echo routes."""
    app = web.Application(middlewares=[make_auth_middleware()])
    if store is not None:
        install_user_store(app, store)

    async def whoami(request: web.Request):
        return web.json_response({"user_id": request.get(USER_ID_REQUEST_KEY)})

    async def healthz(_: web.Request):
        return web.json_response({"ok": True})

    async def spa_shell(_: web.Request):
        return web.Response(text="SPA")

    async def static_asset(_: web.Request):
        return web.Response(text="asset")

    async def login_stub(_: web.Request):
        return web.json_response({"ok": True})

    app.router.add_get("/api/whoami", whoami)
    app.router.add_get("/api/healthz", healthz)
    app.router.add_get("/", spa_shell)
    app.router.add_get("/chat/new", spa_shell)
    app.router.add_get("/static/{path:.*}", static_asset)
    app.router.add_post("/api/auth/login", login_stub)
    return app


@pytest.fixture
async def harness(tmp_path):
    """Spin up the auth app + a UserStore + an aiohttp TestClient."""
    store = UserStore(tmp_path / "web_users.db")
    app = _build_app(store)
    async with TestClient(TestServer(app)) as client:
        yield SimpleNamespace(client=client, store=store)
    store.close()


# ── Public-path bypass ─────────────────────────────────────────────────────


async def test_public_login_endpoint_passes_unauthed(harness):
    resp = await harness.client.post("/api/auth/login")
    assert resp.status == 200


async def test_public_healthz_passes_unauthed(harness):
    resp = await harness.client.get("/api/healthz")
    assert resp.status == 200


async def test_static_asset_passes_unauthed(harness):
    resp = await harness.client.get("/static/foo/bar.css")
    assert resp.status == 200


async def test_spa_shell_root_passes_unauthed(harness):
    resp = await harness.client.get("/")
    assert resp.status == 200


async def test_spa_history_route_passes_unauthed(harness):
    """SPA client-side routes (no file extension, not under /api/) are
    served as the SPA shell — no auth.
    """
    resp = await harness.client.get("/chat/new")
    assert resp.status == 200


async def test_options_preflight_passes_unauthed(harness):
    """CORS preflight always passes through — handler may 405 but the
    middleware itself doesn't 401.
    """
    resp = await harness.client.options("/api/whoami")
    assert resp.status != 401


# ── Cookie auth ────────────────────────────────────────────────────────────


async def test_valid_cookie_authenticates(harness):
    user_id, _ = harness.store.create_user("a@b.co", "long enough password")
    cookie = harness.store.create_web_session(user_id)

    resp = await harness.client.get(
        "/api/whoami",
        cookies={SESSION_COOKIE: cookie},
    )
    assert resp.status == 200
    body = await resp.json()
    assert body["user_id"] == user_id


async def test_invalid_cookie_rejected(harness):
    resp = await harness.client.get(
        "/api/whoami",
        cookies={SESSION_COOKIE: "hermes_ws_deadbeef" + "0" * 56},
    )
    assert resp.status == 401


async def test_missing_cookie_rejected(harness):
    resp = await harness.client.get("/api/whoami")
    assert resp.status == 401


# ── Bearer auth ────────────────────────────────────────────────────────────


async def test_valid_bearer_authenticates(harness):
    user_id, api_key = harness.store.create_user("a@b.co", "long enough password")
    resp = await harness.client.get(
        "/api/whoami",
        headers={"Authorization": f"Bearer {api_key}"},
    )
    assert resp.status == 200
    body = await resp.json()
    assert body["user_id"] == user_id


async def test_invalid_bearer_rejected(harness):
    resp = await harness.client.get(
        "/api/whoami",
        headers={"Authorization": "Bearer hermes_sk_invalid"},
    )
    assert resp.status == 401


async def test_malformed_auth_header_rejected(harness):
    resp = await harness.client.get(
        "/api/whoami",
        headers={"Authorization": "Basic deadbeef"},
    )
    assert resp.status == 401


# ── Combined behavior ─────────────────────────────────────────────────────


async def test_cookie_takes_precedence_over_bearer(harness):
    """If both are present and the cookie is valid, the cookie wins —
    Bearer is the fallback path, not a co-validator.
    """
    alice_id, _ = harness.store.create_user("a@b.co", "long enough password")
    _bob_id, bob_key = harness.store.create_user("b@c.co", "long enough password")
    alice_cookie = harness.store.create_web_session(alice_id)

    resp = await harness.client.get(
        "/api/whoami",
        cookies={SESSION_COOKIE: alice_cookie},
        headers={"Authorization": f"Bearer {bob_key}"},
    )
    body = await resp.json()
    assert body["user_id"] == alice_id  # not bob


async def test_invalid_cookie_falls_back_to_bearer(harness):
    user_id, api_key = harness.store.create_user("a@b.co", "long enough password")
    resp = await harness.client.get(
        "/api/whoami",
        cookies={SESSION_COOKIE: "hermes_ws_invalid" + "0" * 49},
        headers={"Authorization": f"Bearer {api_key}"},
    )
    assert resp.status == 200
    body = await resp.json()
    assert body["user_id"] == user_id


async def test_disabled_user_cookie_rejected(harness):
    user_id, _ = harness.store.create_user("a@b.co", "long enough password")
    cookie = harness.store.create_web_session(user_id)
    harness.store.set_disabled(user_id, True)
    resp = await harness.client.get(
        "/api/whoami",
        cookies={SESSION_COOKIE: cookie},
    )
    assert resp.status == 401


# ── Server misconfiguration ────────────────────────────────────────────────


async def test_missing_user_store_returns_500(tmp_path):
    """If the app is built without install_user_store(), the middleware
    must surface that as a 500 (server config bug), not a 401."""
    app = _build_app(store=None)
    async with TestClient(TestServer(app)) as client:
        resp = await client.get("/api/whoami")
        assert resp.status == 500
        body = await resp.json()
        assert body["error"] == "auth_not_configured"


# ── Cookie issuance helper ────────────────────────────────────────────────


def test_issue_session_cookie_sets_attributes():
    """The cookie helper writes the right Set-Cookie attributes."""
    resp = web.Response()
    issue_session_cookie(resp, "hermes_ws_abc", ttl_seconds=7 * 86400, secure=True)
    morsel = resp.cookies[SESSION_COOKIE]
    assert morsel.value == "hermes_ws_abc"
    assert morsel["httponly"]
    assert morsel["secure"]
    assert morsel["samesite"].lower() == "lax"
    assert morsel["max-age"] == str(7 * 86400)


def test_issue_session_cookie_dev_mode_drops_secure():
    """In dev (HTTP), secure=False so the browser still sends the cookie."""
    resp = web.Response()
    issue_session_cookie(resp, "hermes_ws_abc", ttl_seconds=60, secure=False)
    morsel = resp.cookies[SESSION_COOKIE]
    assert not morsel["secure"]
