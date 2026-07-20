"""Reverse-proxy ``/api/v1/*`` from the web_chat gateway to platform-api.

Production deploys typically put nginx in front (see ``deploy/nginx.conf``).
Local ``./startplatform.sh`` serves the SPA from the gateway on ``:8643``
without nginx — without this proxy the SPA's ``/api/v1/healthz`` probe
hits the gateway auth middleware (401) and the UI falls back to Legacy
API-key login instead of register/login.
"""

from __future__ import annotations

import logging
import os
from typing import Optional
from urllib.parse import urlsplit

from aiohttp import ClientSession, ClientTimeout, DummyCookieJar, web

logger = logging.getLogger("hermes.web.platform_api_proxy")

# Hop-by-hop / framing headers must not be blindly copied (RFC 7230).
_HOP_BY_HOP = frozenset({
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "host",
})

_DEFAULT_LOCAL = "http://127.0.0.1:8700"


def resolve_platform_api_base() -> Optional[str]:
    """Return upstream platform-api origin, or None when not configured.

    Resolution order:
    1. ``PLATFORM_API_URL`` (full origin, e.g. ``http://127.0.0.1:8700``)
    2. ``PLATFORM_API_PORT`` → ``http://127.0.0.1:{port}``
    3. If ``PLATFORM_DATABASE_URL`` is set (Platform stack running), default
       to ``http://127.0.0.1:8700`` for local sidecar DX.
    """
    raw = (os.environ.get("PLATFORM_API_URL") or "").strip()
    if raw:
        return raw.rstrip("/")
    port = (os.environ.get("PLATFORM_API_PORT") or "").strip()
    if port:
        return f"http://127.0.0.1:{port}"
    if (os.environ.get("PLATFORM_DATABASE_URL") or "").strip():
        return _DEFAULT_LOCAL
    return None


def make_platform_api_proxy(upstream_base: str):
    """Build an aiohttp handler that proxies to ``upstream_base``.

    Forwards method, path, query, body, and most headers.  Preserves
    ``Set-Cookie`` so platform register/login sessions work through the
    gateway origin (same cookie name ``hermes_session`` as PlatformStore).
    """
    base = upstream_base.rstrip("/")
    timeout = ClientTimeout(total=120)

    async def proxy(request: web.Request) -> web.StreamResponse:
        target = f"{base}{request.path_qs}"
        headers = {
            k: v
            for k, v in request.headers.items()
            if k.lower() not in _HOP_BY_HOP and k.lower() != "cookie"
        }
        # Prefer the upstream Host so FastAPI / uvicorn see the right name.
        host = urlsplit(base).netloc
        if host:
            headers["Host"] = host

        body = await request.read()
        try:
            # DummyCookieJar + cookies= keeps platform session cookie intact.
            async with ClientSession(
                timeout=timeout,
                cookie_jar=DummyCookieJar(),
            ) as session:
                async with session.request(
                    request.method,
                    target,
                    headers=headers,
                    data=body if body else None,
                    cookies=request.cookies,
                    allow_redirects=False,
                ) as upstream:
                    resp_headers = {
                        k: v
                        for k, v in upstream.headers.items()
                        if k.lower() not in _HOP_BY_HOP
                        and k.lower() != "set-cookie"
                    }
                    data = await upstream.read()
                    response = web.Response(
                        status=upstream.status,
                        body=data,
                        headers=resp_headers,
                    )
                    # aiohttp MultiDict: getall for multiple Set-Cookie.
                    for cookie in upstream.headers.getall("Set-Cookie", ()):
                        response.headers.add("Set-Cookie", cookie)
                    return response
        except OSError as exc:
            logger.warning(
                "platform-api proxy failed (%s → %s): %s",
                request.path, target, exc,
            )
            return web.json_response(
                {"error": "platform_api_unavailable", "detail": str(exc)},
                status=502,
            )

    return proxy


def install_platform_api_proxy(app: web.Application) -> bool:
    """Register ``/api/v1`` proxy routes when an upstream is configured.

    Returns True if routes were installed.
    """
    base = resolve_platform_api_base()
    if not base:
        return False
    handler = make_platform_api_proxy(base)
    # Named catch-all: both ``/api/v1`` and ``/api/v1/...``.
    app.router.add_route("*", "/api/v1/{path:.*}", handler)
    app.router.add_route("*", "/api/v1", handler)
    logger.info("proxying /api/v1/* → %s", base)
    return True
