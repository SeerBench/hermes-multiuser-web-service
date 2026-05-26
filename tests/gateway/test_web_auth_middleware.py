"""Tests for ``gateway.web.auth`` cookie middleware.

Covers the new (post-new-api-integration) contract:

- Whitelisted paths (login, logout, healthz, static, SPA shell) pass
  through unauthenticated.
- ``OPTIONS`` preflight always passes (CORS).
- Valid cookie → handler sees ``request["user_id"]`` and
  ``request["api_key_enc"]``.
- Invalid / missing cookie → ``401``.
- Disabled user → ``401``.
- Bearer tokens are NOT accepted (the new-api key cannot be verified
  cheaply per request; pre-validate-once-then-cookie is the design).
- ``get_request_upstream_key`` decrypts the ciphertext on demand.
"""

import pytest
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from gateway.web.auth import (
    API_KEY_ENC_REQUEST_KEY,
    SESSION_COOKIE,
    USER_ID_REQUEST_KEY,
    get_request_upstream_key,
    install_key_vault,
    install_user_store,
    make_auth_middleware,
)
from gateway.web.key_storage import KeyVault
from gateway.web.users import UserStore


@pytest.fixture
def vault(tmp_path):
    return KeyVault(master_key_path=tmp_path / "master.key")


@pytest.fixture
def store(tmp_path):
    s = UserStore(tmp_path / "web_users.db")
    yield s
    s.close()


def _build_app(
    store: UserStore | None,
    vault: KeyVault | None,
) -> web.Application:
    app = web.Application(middlewares=[make_auth_middleware()])
    if store is not None:
        install_user_store(app, store)
    if vault is not None:
        install_key_vault(app, vault)

    async def whoami(request: web.Request):
        return web.json_response({
            "user_id": request.get(USER_ID_REQUEST_KEY),
            "has_key": bool(request.get(API_KEY_ENC_REQUEST_KEY)),
            "decrypted": get_request_upstream_key(request),
        })

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
    app.router.add_get("/static/file.css", static_asset)
    app.router.add_get("/assets/main.js", static_asset)
    app.router.add_post("/api/auth/login", login_stub)
    app.router.add_post("/api/auth/logout", login_stub)
    return app


@pytest_asyncio.fixture
async def client(store, vault):
    app = _build_app(store, vault)
    async with TestClient(TestServer(app)) as c:
        yield c


# ── Public paths ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_healthz_is_public(client):
    resp = await client.get("/api/healthz")
    assert resp.status == 200


@pytest.mark.asyncio
async def test_login_is_public(client):
    resp = await client.post("/api/auth/login", json={"api_key": "anything"})
    assert resp.status == 200


@pytest.mark.asyncio
async def test_logout_is_public(client):
    resp = await client.post("/api/auth/logout")
    assert resp.status == 200


@pytest.mark.asyncio
async def test_spa_shell_root_is_public(client):
    resp = await client.get("/")
    assert resp.status == 200


@pytest.mark.asyncio
async def test_spa_history_route_is_public(client):
    """No-extension URLs not under /api/ resolve to the SPA shell —
    SPAs use history-mode routing.
    """
    resp = await client.get("/chat/new")
    assert resp.status == 200


@pytest.mark.asyncio
async def test_static_assets_are_public(client):
    assert (await client.get("/static/file.css")).status == 200
    assert (await client.get("/assets/main.js")).status == 200


@pytest.mark.asyncio
async def test_options_preflight_passes_without_auth(client):
    """CORS preflight goes through; the response handler attaches CORS
    headers downstream.
    """
    resp = await client.options("/api/whoami")
    # Without a handler for OPTIONS this can be 405, but it must not
    # be 401 — the middleware should let it past.
    assert resp.status != 401


# ── Authenticated paths ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_protected_path_without_cookie_returns_401(client):
    resp = await client.get("/api/whoami")
    assert resp.status == 401
    body = await resp.json()
    assert body["error"] == "unauthorized"


@pytest.mark.asyncio
async def test_valid_cookie_passes_through(client, store, vault):
    store.upsert_user("u_test01")
    enc = vault.encrypt("sk-upstream-secret")
    token = store.create_web_session("u_test01", enc)
    client.session.cookie_jar.update_cookies({SESSION_COOKIE: token})

    resp = await client.get("/api/whoami")
    assert resp.status == 200
    body = await resp.json()
    assert body["user_id"] == "u_test01"
    assert body["has_key"] is True
    assert body["decrypted"] == "sk-upstream-secret"


@pytest.mark.asyncio
async def test_invalid_cookie_returns_401(client):
    client.session.cookie_jar.update_cookies(
        {SESSION_COOKIE: "hermes_ws_" + "0" * 64}
    )
    resp = await client.get("/api/whoami")
    assert resp.status == 401


@pytest.mark.asyncio
async def test_disabled_user_cookie_returns_401(client, store, vault):
    store.upsert_user("u_disabled")
    enc = vault.encrypt("sk-foo")
    token = store.create_web_session("u_disabled", enc)
    store.set_disabled("u_disabled", True)
    client.session.cookie_jar.update_cookies({SESSION_COOKIE: token})

    resp = await client.get("/api/whoami")
    assert resp.status == 401


@pytest.mark.asyncio
async def test_bearer_token_is_not_accepted(client, store, vault):
    """Per design, the only auth is the cookie — no Bearer fallback.
    A handcrafted Bearer header alone gets a 401 even if the token is
    structurally valid (it isn't a recognised credential type).
    """
    store.upsert_user("u_test01")
    enc = vault.encrypt("sk-foo")
    store.create_web_session("u_test01", enc)
    resp = await client.get(
        "/api/whoami",
        headers={"Authorization": "Bearer sk-anything"},
    )
    assert resp.status == 401


# ── Server-config error ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_missing_user_store_returns_500(vault):
    """Operator misconfiguration shouldn't surface as 401 (which would
    suggest the user did something wrong).  500 makes it visible in
    operator alerting.
    """
    app = _build_app(store=None, vault=vault)
    async with TestClient(TestServer(app)) as client:
        resp = await client.get("/api/whoami")
        assert resp.status == 500
        body = await resp.json()
        assert body["error"] == "auth_not_configured"


# ── get_request_upstream_key edge cases ────────────────────────────────────


@pytest.mark.asyncio
async def test_get_request_upstream_key_returns_none_when_master_key_rotated(
    client, store, tmp_path,
):
    """If the operator rotates the master key, existing session ciphertext
    can't be decrypted; ``get_request_upstream_key`` returns None and the
    chat handler decides to force re-login.
    """
    # Build a session whose api_key_enc is encrypted under a *different*
    # vault than the one wired into the app.
    other_vault = KeyVault(master_key_path=tmp_path / "other.key")
    store.upsert_user("u_rotated")
    enc = other_vault.encrypt("sk-foo")
    token = store.create_web_session("u_rotated", enc)
    client.session.cookie_jar.update_cookies({SESSION_COOKIE: token})

    resp = await client.get("/api/whoami")
    assert resp.status == 200
    body = await resp.json()
    # user_id resolves, has_key is true (ciphertext exists), but the
    # decrypt step fails → decrypted is None.
    assert body["user_id"] == "u_rotated"
    assert body["has_key"] is True
    assert body["decrypted"] is None
