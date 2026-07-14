"""Tests for gateway → platform-api reverse proxy (``/api/v1/*``).

Without this proxy, opening the SPA on ``:8643`` calls ``/api/v1/healthz``
against the gateway itself, gets 401, and falls back to Legacy key login.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from gateway.web.auth import make_auth_middleware
from gateway.web.platform_api_proxy import (
    make_platform_api_proxy,
    resolve_platform_api_base,
)


def test_resolve_platform_api_base_from_url(monkeypatch):
    monkeypatch.setenv("PLATFORM_API_URL", "http://127.0.0.1:8700/")
    monkeypatch.delenv("PLATFORM_API_PORT", raising=False)
    monkeypatch.delenv("PLATFORM_DATABASE_URL", raising=False)
    assert resolve_platform_api_base() == "http://127.0.0.1:8700"


def test_resolve_platform_api_base_from_port(monkeypatch):
    monkeypatch.delenv("PLATFORM_API_URL", raising=False)
    monkeypatch.setenv("PLATFORM_API_PORT", "8700")
    monkeypatch.delenv("PLATFORM_DATABASE_URL", raising=False)
    assert resolve_platform_api_base() == "http://127.0.0.1:8700"


def test_resolve_platform_api_base_defaults_when_db_set(monkeypatch):
    monkeypatch.delenv("PLATFORM_API_URL", raising=False)
    monkeypatch.delenv("PLATFORM_API_PORT", raising=False)
    monkeypatch.setenv("PLATFORM_DATABASE_URL", "sqlite:////tmp/x.db")
    assert resolve_platform_api_base() == "http://127.0.0.1:8700"


def test_resolve_platform_api_base_none_when_unset(monkeypatch):
    monkeypatch.delenv("PLATFORM_API_URL", raising=False)
    monkeypatch.delenv("PLATFORM_API_PORT", raising=False)
    monkeypatch.delenv("PLATFORM_DATABASE_URL", raising=False)
    assert resolve_platform_api_base() is None


@pytest_asyncio.fixture
async def upstream_server():
    """Tiny fake platform-api that records the inbound request."""

    seen: dict = {}

    async def healthz(request: web.Request) -> web.Response:
        seen["path"] = request.path_qs
        seen["method"] = request.method
        seen["cookie"] = request.headers.get("Cookie") or request.cookies.get("hermes_session")
        return web.json_response({"status": "ok", "service": "platform-api"})

    async def echo(request: web.Request) -> web.Response:
        body = await request.read()
        seen["body"] = body
        seen["content_type"] = request.headers.get("Content-Type")
        seen["cookie"] = request.headers.get("Cookie") or request.cookies.get("hermes_session")
        resp = web.json_response({"echo": body.decode("utf-8", errors="replace")})
        resp.set_cookie("hermes_session", "upstream-token", path="/")
        return resp

    app = web.Application()
    app.router.add_get("/api/v1/healthz", healthz)
    app.router.add_post("/api/v1/auth/login", echo)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    yield f"http://127.0.0.1:{port}", seen
    await runner.cleanup()


@pytest_asyncio.fixture
async def gateway_client(upstream_server):
    upstream_base, seen = upstream_server
    proxy = make_platform_api_proxy(upstream_base)

    app = web.Application(
        middlewares=[make_auth_middleware(public_prefixes=("/api/v1/",))]
    )
    # Catch-all under /api/v1 — mirrors web_chat wiring.
    app.router.add_route("*", "/api/v1/{path:.*}", proxy)
    app.router.add_route("*", "/api/v1", proxy)

    async with TestClient(TestServer(app)) as client:
        yield client, seen


@pytest.mark.asyncio
async def test_proxy_forwards_healthz_without_gateway_auth(gateway_client):
    client, seen = gateway_client
    resp = await client.get("/api/v1/healthz")
    assert resp.status == 200
    body = await resp.json()
    assert body["service"] == "platform-api"
    assert seen["path"] == "/api/v1/healthz"
    assert seen["method"] == "GET"


@pytest.mark.asyncio
async def test_proxy_forwards_body_and_set_cookie(gateway_client):
    client, seen = gateway_client
    resp = await client.post(
        "/api/v1/auth/login",
        data=b'{"email":"a@b.c","password":"x"}',
        headers={"Content-Type": "application/json"},
        cookies={"hermes_session": "old"},
    )
    assert resp.status == 200
    body = await resp.json()
    assert "email" in body["echo"]
    # Cookie may arrive as header or as parsed jar value depending on aiohttp.
    assert seen.get("cookie") in ("hermes_session=old", "old")
    # Upstream Set-Cookie must reach the browser unchanged in name.
    assert "hermes_session=" in resp.headers.get("Set-Cookie", "")


@pytest.mark.asyncio
async def test_api_v1_without_proxy_route_is_still_not_401():
    """Auth middleware must not block /api/v1 even when no proxy is mounted
    (deploy behind nginx may omit the gateway proxy).
    """
    async def not_found(_: web.Request) -> web.Response:
        return web.json_response({"error": "no_route"}, status=404)

    app = web.Application(middlewares=[make_auth_middleware()])
    app.router.add_get("/api/v1/healthz", not_found)
    async with TestClient(TestServer(app)) as client:
        resp = await client.get("/api/v1/healthz")
        assert resp.status == 404
        assert resp.status != 401
