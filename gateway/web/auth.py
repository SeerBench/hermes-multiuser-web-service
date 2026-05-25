"""Cookie + Bearer authentication middleware for ``web_chat``.

Two auth surfaces:

- **Cookie** (``hermes_session``) — issued by ``/api/auth/login`` and
  ``/api/auth/register``, used by the SPA for normal requests.  TTL is
  configurable (default 7 days).  Server-side state in
  ``web_users.web_sessions``; the cookie body itself is a random token
  whose ``sha256`` is the row key.
- **Bearer** (``Authorization: Bearer hermes_sk_…``) — for SPA-less
  consumers (curl, scripts, OpenAI-style clients pointed at web_chat).
  Issued via ``/api/keys``, stored as ``sha256(plaintext)`` in
  ``web_users.api_keys``.

The middleware:

1. Lets a small whitelist of paths through unauthenticated (SPA entry,
   static assets, register, login, healthz, OPTIONS preflight).
2. Tries the cookie first, then the Authorization header.  First valid
   wins; the resolved ``user_id`` is set on ``request["user_id"]`` so
   handlers can read it without re-parsing.
3. Returns ``401 {"error": "unauthorized"}`` on failure.

Cookie attributes (``HttpOnly``, ``Secure``, ``SameSite=Lax``) are set
by :func:`issue_session_cookie` / :func:`clear_session_cookie`.  The
``Secure`` flag is gated on the request scheme so local-dev HTTP works;
production deployments must front the gateway with TLS.
"""

from __future__ import annotations

import logging
from typing import Awaitable, Callable, Iterable, Optional

from aiohttp import web

from gateway.web.users import InvalidCredentialsError, UserStore

logger = logging.getLogger("hermes.web.auth")

# Session cookie name.  Keep it boring + distinct from any other Hermes
# cookie a future dashboard might add.
SESSION_COOKIE = "hermes_session"

# aiohttp app key under which the UserStore is registered.  Uses the
# typed AppKey idiom (aiohttp 3.9+) — avoids the NotAppKeyWarning and
# makes ``request.app[USER_STORE_APP_KEY]`` typecheckable.
USER_STORE_APP_KEY: "web.AppKey[UserStore]" = web.AppKey("user_store", UserStore)

# aiohttp request key under which the authenticated user_id is exposed.
USER_ID_REQUEST_KEY = "user_id"

# Default whitelist of paths that pass through the middleware
# without authentication.  Handlers for these paths must of course be
# safe to expose anonymously (login, register, healthz, static).
_DEFAULT_PUBLIC_PATHS: frozenset[str] = frozenset({
    "/api/auth/register",
    "/api/auth/login",
    "/api/healthz",
    "/healthz",
})

# Path prefixes that bypass auth (SPA assets).
_DEFAULT_PUBLIC_PREFIXES: tuple[str, ...] = (
    "/static/",
    "/assets/",
)


def install_user_store(app: web.Application, store: UserStore) -> None:
    """Attach the UserStore to an aiohttp app for the middleware to find."""
    app[USER_STORE_APP_KEY] = store


def get_user_store(app: web.Application) -> UserStore:
    """Read the UserStore back out (raises KeyError if not installed)."""
    return app[USER_STORE_APP_KEY]


def get_request_user_id(request: web.Request) -> Optional[str]:
    """Return the authenticated ``user_id``, or None on a public route.

    Handlers behind the middleware can rely on this being non-None.
    """
    return request.get(USER_ID_REQUEST_KEY)


def _is_spa_entry(path: str) -> bool:
    """The SPA entrypoint (``/``) and its client-side routes are static
    HTML, served unauthenticated.  The SPA itself then calls
    ``/api/auth/login`` to obtain a cookie.
    """
    if path == "/":
        return True
    # SPA history-mode routes — anything without an extension that isn't
    # under /api/ is the SPA shell.
    if path.startswith("/api/"):
        return False
    if "." in path.rsplit("/", 1)[-1]:
        # Has a file extension — let the static handler answer it.
        return False
    return True


def make_auth_middleware(
    *,
    public_paths: Iterable[str] = (),
    public_prefixes: Iterable[str] = (),
):
    """Build an aiohttp middleware tied to a UserStore mounted on the app.

    Extra ``public_paths`` / ``public_prefixes`` are *added to* the
    built-in whitelist, not replacing it.
    """
    extra_paths = frozenset(_DEFAULT_PUBLIC_PATHS) | frozenset(public_paths)
    extra_prefixes = tuple(_DEFAULT_PUBLIC_PREFIXES) + tuple(public_prefixes)

    @web.middleware
    async def auth_middleware(
        request: web.Request,
        handler: Callable[[web.Request], Awaitable[web.StreamResponse]],
    ) -> web.StreamResponse:
        # CORS preflight always allowed; the response handler attaches the
        # right CORS headers separately.
        if request.method == "OPTIONS":
            return await handler(request)

        path = request.path
        if path in extra_paths:
            return await handler(request)
        if any(path.startswith(p) for p in extra_prefixes):
            return await handler(request)
        if _is_spa_entry(path):
            return await handler(request)

        store = request.app.get(USER_STORE_APP_KEY)
        if store is None:
            logger.error("auth middleware active but UserStore not installed on app")
            return web.json_response(
                {"error": "auth_not_configured"}, status=500
            )

        # 1) Cookie
        cookie = request.cookies.get(SESSION_COOKIE)
        if cookie:
            try:
                request[USER_ID_REQUEST_KEY] = store.verify_web_session(cookie)
                return await handler(request)
            except InvalidCredentialsError:
                pass  # fall through to Bearer

        # 2) Bearer
        auth_hdr = request.headers.get("Authorization", "")
        if auth_hdr.startswith("Bearer "):
            token = auth_hdr[len("Bearer "):].strip()
            try:
                request[USER_ID_REQUEST_KEY] = store.verify_api_key(token)
                return await handler(request)
            except InvalidCredentialsError:
                pass

        return web.json_response({"error": "unauthorized"}, status=401)

    return auth_middleware


def issue_session_cookie(
    response: web.StreamResponse,
    token: str,
    *,
    ttl_seconds: int,
    secure: bool,
) -> None:
    """Attach the ``hermes_session`` cookie to ``response``.

    ``token`` is the plaintext returned by ``UserStore.create_web_session``.
    ``ttl_seconds`` must match the value passed to ``create_web_session``
    so the cookie expiry tracks the server-side row expiry.
    ``secure`` should be True in production (HTTPS only) and False in
    local-dev HTTP.
    """
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=ttl_seconds,
        path="/",
        httponly=True,
        secure=secure,
        samesite="Lax",
    )


def clear_session_cookie(response: web.StreamResponse, *, secure: bool) -> None:
    """Expire the ``hermes_session`` cookie on logout."""
    response.del_cookie(SESSION_COOKIE, path="/")
    # del_cookie sets Max-Age=0; secure/samesite don't strictly matter on
    # an expiring cookie but we keep them consistent for cleanliness.
    # aiohttp's del_cookie API doesn't accept those kwargs, so this is a
    # no-op placeholder — kept for symmetry with issue_session_cookie.
    _ = secure
