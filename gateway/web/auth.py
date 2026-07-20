"""Cookie authentication middleware for ``web_chat``.

The web_chat platform identifies users by a single cookie
(``hermes_session``).  Cookies are issued by ``POST /api/auth/login``
after the user pastes a new-api key and the gateway validates it via
:mod:`gateway.web.upstream_validator`; the cookie body is a random
token whose ``sha256`` is the row key in ``web_users.web_sessions``,
and the row also carries the user's new-api key encrypted under the
gateway's :class:`gateway.web.key_storage.KeyVault`.

Bearer tokens are intentionally **not** accepted here: the user's
new-api key is the only credential, and verifying it on every request
would require a round-trip to the upstream gateway.  Pre-validating
once at login (and binding the result to a short-lived cookie) is the
right speed/security trade-off for an interactive web SPA.  Scripted /
SDK clients should talk to the upstream new-api directly, not through
this gateway's chat surface.

The middleware:

1. Lets a small whitelist of paths through unauthenticated (SPA shell,
   static assets, login, healthz, OPTIONS preflight).
2. Looks up the cookie in the UserStore.  On hit, exposes both the
   ``user_id`` and the ciphertext of the user's new-api key on the
   request object so handlers can lazily decrypt via
   :func:`get_request_upstream_key`.
3. Returns ``401 {"error": "unauthorized"}`` on miss.

Cookie attributes (``HttpOnly``, ``Secure``, ``SameSite=Lax``) are set
by :func:`issue_session_cookie` / :func:`clear_session_cookie`.  The
``Secure`` flag is gated on the request scheme so local-dev HTTP
works; production deployments must front the gateway with TLS.
"""

from __future__ import annotations

import logging
from typing import Awaitable, Callable, Iterable, Optional

from aiohttp import web

from gateway.web.key_storage import KeyVault, KeyVaultError
from gateway.web.users import InvalidCredentialsError, UserStore

logger = logging.getLogger("hermes.web.auth")

# Session cookie name.  Keep it boring + distinct from any other Hermes
# cookie a future dashboard might add.
SESSION_COOKIE = "hermes_session"

# aiohttp app keys.  Using the typed AppKey idiom (aiohttp 3.9+) avoids
# the NotAppKeyWarning and makes ``request.app[KEY]`` typecheckable.
USER_STORE_APP_KEY: "web.AppKey[UserStore]" = web.AppKey("user_store", UserStore)
KEY_VAULT_APP_KEY: "web.AppKey[KeyVault]" = web.AppKey("key_vault", KeyVault)

# aiohttp request keys exposed by the middleware.
USER_ID_REQUEST_KEY = "user_id"
API_KEY_ENC_REQUEST_KEY = "api_key_enc"

# Default whitelist of paths that pass through the middleware
# without authentication.  Handlers for these paths must of course be
# safe to expose anonymously (login, healthz, static).
_DEFAULT_PUBLIC_PATHS: frozenset[str] = frozenset({
    "/api/auth/login",
    "/api/auth/logout",
    "/api/healthz",
    "/healthz",
    "/logo.svg",
    "/logo.png",
    "/favicon.png",
    "/favicon.ico",
})

# Path prefixes that bypass auth (SPA assets + platform control plane).
# ``/api/v1/`` is authenticated by platform-api itself (or nginx/gateway
# reverse-proxy); the gateway must not 401 those probes or the SPA falls
# back to Legacy API-key login.
_DEFAULT_PUBLIC_PREFIXES: tuple[str, ...] = (
    "/static/",
    "/assets/",
    "/api/v1/",
)


def install_user_store(app: web.Application, store: UserStore) -> None:
    """Attach the UserStore to an aiohttp app for the middleware to find."""
    app[USER_STORE_APP_KEY] = store


def get_user_store(app: web.Application) -> UserStore:
    """Read the UserStore back out (raises KeyError if not installed)."""
    return app[USER_STORE_APP_KEY]


def install_key_vault(app: web.Application, vault: KeyVault) -> None:
    """Attach the KeyVault for upstream-key decryption."""
    app[KEY_VAULT_APP_KEY] = vault


def get_key_vault(app: web.Application) -> KeyVault:
    return app[KEY_VAULT_APP_KEY]


def get_request_user_id(request: web.Request) -> Optional[str]:
    """Return the authenticated ``user_id``, or None on a public route.

    Handlers behind the middleware can rely on this being non-None.
    """
    return request.get(USER_ID_REQUEST_KEY)


def get_request_upstream_key(request: web.Request) -> Optional[str]:
    """Return the plaintext new-api key for the current request.

    Decrypts ``api_key_enc`` stored on the request by the auth
    middleware using the app's :class:`KeyVault`.  Returns ``None`` if
    the request is on a public route, or if decryption fails (which
    means the master key was rotated — the chat handler treats this as
    "session invalid, force re-login").
    """
    enc = request.get(API_KEY_ENC_REQUEST_KEY)
    if not enc:
        return None
    vault = request.app.get(KEY_VAULT_APP_KEY)
    if vault is None:
        logger.error("get_request_upstream_key called but KeyVault not installed")
        return None
    try:
        return vault.decrypt(enc)
    except KeyVaultError as exc:
        logger.warning("upstream key decryption failed: %s", exc)
        return None


def _is_spa_entry(path: str) -> bool:
    """The SPA entrypoint (``/``) and its client-side routes are static
    HTML, served unauthenticated.  The SPA itself then calls
    ``/api/auth/login`` to obtain a cookie once the user pastes a key.
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
        # CORS preflight always allowed; the response handler attaches
        # the right CORS headers separately.
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

        cookie = request.cookies.get(SESSION_COOKIE)
        if cookie:
            try:
                session = store.verify_web_session(cookie)
                request[USER_ID_REQUEST_KEY] = session["user_id"]
                request[API_KEY_ENC_REQUEST_KEY] = session["api_key_enc"]
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
    _ = secure  # kept for symmetry with issue_session_cookie
