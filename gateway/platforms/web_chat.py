"""Multi-user web chat platform adapter.

HTTP gateway adapter for the self-hosted multi-user web service.  Wires
together everything from ``gateway/web/``:

- ``UserStore`` for cookie sessions and the (minimal) per-user record
- ``KeyVault`` for symmetric encryption of the user's new-api key
- ``validate_key_against_upstream`` for pre-login key probing
- ``make_auth_middleware`` for cookie auth
- ``enter_user_context`` / ``enter_upstream_key`` to bind workspace +
  ``HERMES_HOME`` + per-request upstream key
- ``WebChatAgentRunner`` to spawn AIAgent inside an executor thread

Mirror-but-independent of ``gateway/platforms/api_server.py`` (see
``gateway/web/chat_runner.py`` docstring for the upstream-sync
rationale).  ``api_server.py`` stays untouched; this adapter exists in
parallel and is the surface the React SPA talks to.

HTTP surface
------------

==========  =========================  =================================
Method      Path                       Purpose
==========  =========================  =================================
POST        /api/auth/login            validate new-api key + set cookie
POST        /api/auth/logout           expire cookie
GET         /api/me                    current user_id + timestamps
GET         /api/conversations         list user's sessions
POST        /api/chat                  SSE stream of agent response
GET         /api/healthz               public health probe
GET         /static/...                SPA static assets
GET         /                          SPA shell
==========  =========================  =================================

No registration endpoint — accounts are issued by the upstream new-api
gateway.  No quota endpoint — billing is the upstream's responsibility.
No /api/keys/* endpoints — keys aren't minted here; they're pasted in
at the login modal.

SSE event protocol (``/api/chat`` only)
---------------------------------------

The chat handler responds with ``text/event-stream`` and emits the
following ``event:``-tagged frames, each with a JSON ``data:`` body:

- ``token``      — incremental assistant token delta
- ``tool_start`` — a tool call began
- ``tool_end``   — a tool call finished
- ``reasoning``  — model reasoning text (when the provider exposes it)
- ``done``       — final summary, includes ``session_id`` + ``usage``
- ``error``      — fatal error before ``done``

The protocol is UI-friendly rather than OpenAI-compat: per-event
discrimination via the SSE ``event:`` field, structured payloads.
External OpenAI-compat clients should talk to the upstream new-api
gateway directly, not to this surface.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import socket as _socket
import time
import uuid
from typing import Any, Dict, List, Optional

try:
    from aiohttp import web
    AIOHTTP_AVAILABLE = True
except ImportError:
    web = None  # type: ignore[assignment]
    AIOHTTP_AVAILABLE = False

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import BasePlatformAdapter, SendResult
from gateway.web.auth import (
    SESSION_COOKIE,
    clear_session_cookie,
    get_request_upstream_key,
    get_request_user_id,
    install_key_vault,
    install_user_store,
    issue_session_cookie,
    make_auth_middleware,
)
from gateway.web.chat_runner import WebChatAgentRunner
from gateway.web.key_storage import KeyVault, KeyVaultError
from gateway.web.sandbox import enter_user_context
from gateway.web.upstream_key import derive_user_id, enter_upstream_key
from gateway.web.upstream_validator import validate_key_against_upstream
from gateway.web.users import (
    InvalidCredentialsError,
    UserStore,
    UserStoreError,
)

logger = logging.getLogger("hermes.gateway.web_chat")


# ── Module-level constants ─────────────────────────────────────────────────

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8643
MAX_REQUEST_BYTES = 10_000_000  # 10 MB — match api_server.py

# Cookie TTL (configurable; default 7 days per plan).
_DEFAULT_COOKIE_TTL_SECONDS = 7 * 24 * 3600

# Conversation listing default
_LIST_CONVERSATIONS_DEFAULT_LIMIT = 50
_LIST_CONVERSATIONS_MAX_LIMIT = 200


def check_web_chat_requirements() -> bool:
    """Return True if optional deps for web_chat are importable.

    Called by gateway startup to decide whether to even attempt
    instantiating ``WebChatAdapter``.  aiohttp + cryptography are
    required (the latter for KeyVault); aiohttp is shared with
    api_server, cryptography ships as a transitive of PyJWT[crypto].
    """
    if not AIOHTTP_AVAILABLE:
        return False
    try:
        import cryptography.fernet  # noqa: F401
    except ImportError:
        return False
    return True


# ── Adapter ────────────────────────────────────────────────────────────────


class WebChatAdapter(BasePlatformAdapter):
    """Self-hosted multi-user web chat platform.

    Lifecycle (driven by ``GatewayRunner``):
    1. ``__init__`` — construct from ``PlatformConfig``; instantiate
       ``UserStore`` + ``KeyVault`` + ``WebChatAgentRunner``.
    2. ``connect()`` — verify ``NEW_API_BASE_URL`` is configured, build
       aiohttp app, wire routes + middleware, bind socket.
    3. ``disconnect()`` — graceful shutdown of the aiohttp runner and
       close ``UserStore``.

    All chat traffic is request/response — there is no inbound stream
    of "messages" to receive, so ``send()`` is unused.
    """

    def __init__(self, config: PlatformConfig):
        super().__init__(config, Platform.WEB_CHAT)
        extra = config.extra or {}

        # ── Network ──
        self._host: str = extra.get(
            "host", os.getenv("WEB_CHAT_HOST", DEFAULT_HOST)
        )
        raw_port = extra.get("port")
        if raw_port is None:
            raw_port = os.getenv("WEB_CHAT_PORT", str(DEFAULT_PORT))
        try:
            self._port: int = int(raw_port)
        except (TypeError, ValueError):
            logger.warning(
                "[%s] invalid port %r — falling back to %d",
                self.name, raw_port, DEFAULT_PORT,
            )
            self._port = DEFAULT_PORT

        # ── Cookie + Auth tuning ──
        self._cookie_secure: bool = bool(
            extra.get("cookie_secure", os.getenv("WEB_CHAT_COOKIE_SECURE", "0") == "1")
        )
        try:
            self._cookie_ttl_seconds: int = int(
                extra.get(
                    "cookie_ttl_seconds",
                    os.getenv("WEB_CHAT_COOKIE_TTL_SECONDS", _DEFAULT_COOKIE_TTL_SECONDS),
                )
            )
        except (TypeError, ValueError):
            self._cookie_ttl_seconds = _DEFAULT_COOKIE_TTL_SECONDS

        self._allow_insecure_bind: bool = bool(
            extra.get(
                "allow_insecure_bind",
                os.getenv("WEB_CHAT_ALLOW_INSECURE_BIND", "0") == "1",
            )
        )

        # ── Upstream new-api gateway ──
        # Required.  We resolve it lazily in connect() so __init__ stays
        # cheap and importable even when the env isn't fully set up
        # (e.g. during config reloads or unit tests).
        self._new_api_base_url: str = (
            extra.get("new_api_base_url")
            or os.getenv("NEW_API_BASE_URL", "")
        ).strip().rstrip("/")

        # ── Concurrency limit ──
        try:
            self._max_concurrent_agents: int = int(
                extra.get(
                    "max_concurrent_agents",
                    os.getenv("WEB_CHAT_MAX_CONCURRENT_AGENTS", "12"),
                )
            )
        except (TypeError, ValueError):
            self._max_concurrent_agents = 12
        self._agent_semaphore: Optional[asyncio.Semaphore] = None  # created at connect

        # ── Sub-systems (constructed lazily in connect) ──
        self._user_store: Optional[UserStore] = None
        self._key_vault: Optional[KeyVault] = None
        self._runner: Optional[WebChatAgentRunner] = None
        self._session_db: Optional[Any] = None

        # ── aiohttp server state ──
        self._app: Optional["web.Application"] = None
        self._aio_runner: Optional["web.AppRunner"] = None
        self._site: Optional["web.TCPSite"] = None

    # ── Lifecycle ──────────────────────────────────────────────────────

    async def connect(self) -> bool:
        if not check_web_chat_requirements():
            logger.warning(
                "[%s] aiohttp and/or cryptography not installed — install "
                "the [web-chat] extra to enable",
                self.name,
            )
            return False

        if not self._new_api_base_url:
            logger.error(
                "[%s] NEW_API_BASE_URL is not configured — set it via .env "
                "or platforms.web_chat.extra.new_api_base_url in config.yaml. "
                "The multi-user web service routes every LLM call through an "
                "upstream new-api gateway; without that URL we have nowhere "
                "to send requests.",
                self.name,
            )
            return False

        try:
            # Importing this package registers the sandboxed file tools
            # (web_file_read / web_file_write / web_file_patch /
            # web_file_search) via side effect.
            import gateway.web.tools  # noqa: F401

            self._user_store = UserStore()
            self._key_vault = KeyVault()
            self._session_db = self._ensure_session_db()
            self._runner = WebChatAgentRunner(session_db=self._session_db)
            self._agent_semaphore = asyncio.Semaphore(self._max_concurrent_agents)
        except Exception as exc:
            logger.error("[%s] failed to initialise subsystems: %s", self.name, exc)
            return False

        try:
            self._app = web.Application(
                middlewares=[make_auth_middleware()],
                client_max_size=MAX_REQUEST_BYTES,
            )
            install_user_store(self._app, self._user_store)
            install_key_vault(self._app, self._key_vault)
            self._wire_routes(self._app)

            if (
                self._is_network_accessible(self._host)
                and not self._cookie_secure
                and not self._allow_insecure_bind
            ):
                logger.error(
                    "[%s] refusing to bind %s without cookie_secure=true. "
                    "For LAN / Tailscale / behind-proxy testing, set "
                    "platforms.web_chat.extra.allow_insecure_bind: true "
                    "in config.yaml (cookies still travel as plain HTTP — "
                    "only safe when the network layer encrypts transit).",
                    self.name, self._host,
                )
                return False
            if (
                self._is_network_accessible(self._host)
                and not self._cookie_secure
                and self._allow_insecure_bind
            ):
                logger.warning(
                    "[%s] binding %s with allow_insecure_bind=true — "
                    "session cookies travel as plain HTTP. Only safe "
                    "when the underlying network encrypts transit "
                    "(Tailscale / WireGuard / VPN / local reverse proxy "
                    "on the same host).",
                    self.name, self._host,
                )

            if self._port_in_use(self._host, self._port):
                logger.error(
                    "[%s] port %d already in use — set platforms.web_chat.port",
                    self.name, self._port,
                )
                return False

            self._aio_runner = web.AppRunner(self._app)
            await self._aio_runner.setup()
            self._site = web.TCPSite(self._aio_runner, self._host, self._port)
            await self._site.start()

            self._mark_connected()
            logger.info(
                "[%s] listening on http://%s:%d  (new-api: %s, max_concurrent=%d)",
                self.name, self._host, self._port,
                self._new_api_base_url, self._max_concurrent_agents,
            )
            return True
        except Exception as exc:
            logger.error("[%s] failed to start: %s", self.name, exc, exc_info=True)
            return False

    async def disconnect(self) -> None:
        self._mark_disconnected()
        if self._site is not None:
            try:
                await self._site.stop()
            except Exception:
                logger.debug("[%s] site.stop() failed", self.name, exc_info=True)
            self._site = None
        if self._aio_runner is not None:
            try:
                await self._aio_runner.cleanup()
            except Exception:
                logger.debug("[%s] runner.cleanup() failed", self.name, exc_info=True)
            self._aio_runner = None
        self._app = None
        if self._user_store is not None:
            try:
                self._user_store.close()
            except Exception:
                logger.debug("[%s] user_store.close() failed", self.name, exc_info=True)
            self._user_store = None
        logger.info("[%s] stopped", self.name)

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        """Not used — web_chat is request/response, not push."""
        return SendResult(
            success=False,
            error="web_chat is request/response; use /api/chat instead",
        )

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {
            "platform": "web_chat",
            "host": self._host,
            "port": self._port,
        }

    # ── Routes ─────────────────────────────────────────────────────────

    def _wire_routes(self, app: "web.Application") -> None:
        app.router.add_get("/api/healthz", self._handle_healthz)
        app.router.add_post("/api/auth/login", self._handle_login)
        app.router.add_post("/api/auth/logout", self._handle_logout)
        app.router.add_get("/api/me", self._handle_me)
        app.router.add_get("/api/conversations", self._handle_list_conversations)
        app.router.add_post("/api/chat", self._handle_chat)
        # SPA shell + static assets.
        from pathlib import Path as _Path
        static_dir = _Path(__file__).resolve().parent.parent / "web" / "_static"
        index_html = static_dir / "index.html"
        if index_html.is_file():
            assets_dir = static_dir / "assets"
            if assets_dir.is_dir():
                app.router.add_static("/assets/", path=str(assets_dir), name="spa_assets")
            self._spa_index_path = index_html
            app.router.add_get("/", self._handle_spa_index)
        else:
            self._spa_index_path = None
            app.router.add_get("/", self._handle_spa_shell)

    # ── Helpers ────────────────────────────────────────────────────────

    @staticmethod
    def _is_network_accessible(host: str) -> bool:
        """True if ``host`` would accept connections from outside the box."""
        return host not in ("127.0.0.1", "localhost", "::1")

    @staticmethod
    def _port_in_use(host: str, port: int) -> bool:
        try:
            with _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM) as s:
                s.settimeout(1)
                s.connect(("127.0.0.1", port))
            return True
        except (ConnectionRefusedError, OSError):
            return False

    def _ensure_session_db(self) -> Optional[Any]:
        if self._session_db is not None:
            return self._session_db
        try:
            from hermes_state import SessionDB
            self._session_db = SessionDB()
        except Exception as exc:
            logger.warning("[%s] SessionDB unavailable: %s", self.name, exc)
            self._session_db = None
        return self._session_db

    @staticmethod
    def _json_error(message: str, *, status: int = 400, code: str = None) -> "web.Response":
        body = {"error": message}
        if code:
            body["code"] = code
        return web.json_response(body, status=status)

    # ── /api/healthz ───────────────────────────────────────────────────

    async def _handle_healthz(self, request: "web.Request") -> "web.Response":
        return web.json_response({
            "status": "ok",
            "platform": "web_chat",
            "ts": time.time(),
        })

    # ── /api/auth/* ────────────────────────────────────────────────────

    async def _handle_login(self, request: "web.Request") -> "web.Response":
        """Validate a new-api key, derive ``user_id``, sign a cookie."""
        try:
            body = await request.json()
        except Exception:
            return self._json_error("invalid JSON")
        api_key = (body.get("api_key") or "").strip()
        if not api_key:
            return self._json_error(
                "api_key required",
                status=400,
                code="missing_api_key",
            )

        # Probe the upstream to make sure the key works before we even
        # touch the local DB.  Sub-second on a healthy gateway; the
        # validator already bounds itself to a 10s timeout for the
        # pathological case.
        validation = await validate_key_against_upstream(
            api_key, self._new_api_base_url
        )
        if not validation.valid:
            # Map the validator's three failure modes to distinct HTTP
            # statuses so the SPA can render targeted error messages.
            if validation.error_code == "invalid_key":
                status = 401
            elif validation.error_code == "misconfigured":
                # Operator's fault — fail with 502 (bad gateway) so it
                # shows up in operator dashboards rather than user logs.
                status = 502
            else:  # upstream_unreachable
                status = 503
            logger.info(
                "[%s] login rejected (%s): %s",
                self.name, validation.error_code, validation.error_msg,
            )
            return self._json_error(
                "key validation failed",
                status=status,
                code=validation.error_code or "validation_failed",
            )

        # Key is good — bind it to a stable user_id and persist a cookie.
        user_id = derive_user_id(api_key)
        try:
            self._user_store.upsert_user(user_id)
            encrypted = self._key_vault.encrypt(api_key)
            cookie_token = self._user_store.create_web_session(
                user_id, encrypted, ttl_seconds=self._cookie_ttl_seconds,
            )
        except (UserStoreError, KeyVaultError) as exc:
            logger.error("[%s] login persistence failed: %s", self.name, exc)
            return self._json_error("internal error", status=500)

        resp = web.json_response({"user_id": user_id})
        issue_session_cookie(
            resp, cookie_token,
            ttl_seconds=self._cookie_ttl_seconds,
            secure=self._cookie_secure,
        )
        logger.info("[%s] login user_id=%s", self.name, user_id)
        return resp

    async def _handle_logout(self, request: "web.Request") -> "web.Response":
        # Best-effort: invalidate the server-side row so even if the
        # client doesn't drop the cookie, it can't be reused.
        cookie = request.cookies.get(SESSION_COOKIE)
        if cookie:
            try:
                self._user_store.delete_web_session(cookie)
            except Exception:
                logger.debug("[%s] delete_web_session failed", self.name, exc_info=True)
        resp = web.json_response({"ok": True})
        clear_session_cookie(resp, secure=self._cookie_secure)
        return resp

    # ── /api/me ────────────────────────────────────────────────────────

    async def _handle_me(self, request: "web.Request") -> "web.Response":
        """Return the current user's identifier and timestamps.

        Useful for the SPA's settings page ("Logged in as: u_xxxx").
        Does not expose the upstream key — that stays server-side
        encrypted and is only ever materialised inside a chat request
        context.
        """
        user_id = get_request_user_id(request)
        user = self._user_store.get_user(user_id) if user_id else None
        if not user:
            return self._json_error("user not found", status=404)
        return web.json_response({
            "user_id": user["user_id"],
            "created_at": user["created_at"],
            "last_seen_at": user["last_seen_at"],
        })

    # ── /api/conversations ─────────────────────────────────────────────

    async def _handle_list_conversations(self, request: "web.Request") -> "web.Response":
        user_id = get_request_user_id(request)
        try:
            limit = int(request.query.get("limit", _LIST_CONVERSATIONS_DEFAULT_LIMIT))
        except (TypeError, ValueError):
            limit = _LIST_CONVERSATIONS_DEFAULT_LIMIT
        limit = max(1, min(limit, _LIST_CONVERSATIONS_MAX_LIMIT))
        try:
            offset = max(0, int(request.query.get("offset", 0)))
        except (TypeError, ValueError):
            offset = 0

        db = self._ensure_session_db()
        if db is None:
            return web.json_response({"conversations": []})
        try:
            rows = db.list_sessions_rich(
                user_id=user_id,
                limit=limit,
                offset=offset,
                order_by_last_active=True,
            )
        except Exception as exc:
            logger.error("[%s] list_sessions_rich failed: %s", self.name, exc, exc_info=True)
            return self._json_error("conversation list unavailable", status=500)

        projected = [
            {
                "id": r.get("id"),
                "title": r.get("title"),
                "preview": r.get("preview", ""),
                "started_at": r.get("started_at"),
                "last_active": r.get("last_active"),
                "message_count": r.get("message_count", 0),
            }
            for r in rows
        ]
        return web.json_response({"conversations": projected})

    # ── /api/chat ──────────────────────────────────────────────────────

    async def _handle_chat(self, request: "web.Request") -> "web.StreamResponse":
        user_id = get_request_user_id(request)
        upstream_key = get_request_upstream_key(request)
        if not upstream_key:
            # Cookie is good but the encrypted key didn't decrypt — the
            # master key was rotated, or the row is corrupt.  Force a
            # re-login by returning 401 so the SPA reopens the key modal.
            return self._json_error(
                "session expired", status=401, code="session_expired",
            )

        # Parse body
        try:
            body = await request.json()
        except Exception:
            return self._json_error("invalid JSON")
        user_message = (body.get("message") or "").strip()
        if not user_message:
            return self._json_error("message required")
        session_id = body.get("session_id") or f"web_{uuid.uuid4().hex[:12]}"
        ephemeral_system_prompt = body.get("system_prompt") or None
        conversation_history = body.get("conversation_history") or []
        if not isinstance(conversation_history, list):
            return self._json_error("conversation_history must be a list")
        gateway_session_key = body.get("session_key") or f"web::{user_id}"

        if self._agent_semaphore is None:
            return self._json_error("server not ready", status=503)

        # Open the SSE response.
        resp = web.StreamResponse(
            status=200,
            headers={
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",  # nginx: don't buffer SSE
            },
        )
        await resp.prepare(request)

        loop = asyncio.get_running_loop()
        event_queue: asyncio.Queue[Optional[Dict[str, Any]]] = asyncio.Queue()

        def _push(event_type: str, payload: Dict[str, Any]) -> None:
            try:
                loop.call_soon_threadsafe(
                    event_queue.put_nowait, {"event": event_type, "data": payload}
                )
            except Exception:
                pass  # best-effort — SSE consumer may have disconnected

        def stream_delta_cb(text: str, **_kwargs) -> None:
            if text:
                _push("token", {"text": text})

        def tool_start_cb(name: str, preview: str = None, **_kwargs) -> None:
            _push("tool_start", {"tool": name, "preview": preview or ""})

        def tool_complete_cb(name: str, **kwargs) -> None:
            _push("tool_end", {
                "tool": name,
                "duration": round(float(kwargs.get("duration", 0)), 3),
                "error": bool(kwargs.get("is_error", False)),
            })

        agent_ref: List[Any] = [None]

        async with self._agent_semaphore:
            # ContextVar nesting: workspace (filesystem sandbox +
            # HERMES_HOME override) outer, upstream key inner.  Both
            # propagate into the agent's executor thread automatically.
            with enter_user_context(user_id), enter_upstream_key(upstream_key):
                writer_task = asyncio.create_task(
                    self._sse_writer(resp, event_queue),
                    name=f"web_chat-sse-{session_id}",
                )

                try:
                    result, usage = await self._runner.run(
                        user_id=user_id,
                        user_message=user_message,
                        conversation_history=conversation_history,
                        ephemeral_system_prompt=ephemeral_system_prompt,
                        session_id=session_id,
                        stream_delta_callback=stream_delta_cb,
                        tool_start_callback=tool_start_cb,
                        tool_complete_callback=tool_complete_cb,
                        agent_ref=agent_ref,
                        gateway_session_key=gateway_session_key,
                    )
                except asyncio.CancelledError:
                    if agent_ref[0] is not None:
                        try:
                            agent_ref[0].interrupt()
                        except Exception:
                            logger.debug("[%s] interrupt failed", self.name, exc_info=True)
                    raise
                except Exception as exc:
                    logger.error(
                        "[%s] agent run failed for user=%s session=%s: %s",
                        self.name, user_id, session_id, exc, exc_info=True,
                    )
                    _push("error", {"message": str(exc), "code": "agent_error"})
                    await event_queue.put(None)
                    try:
                        await writer_task
                    except Exception:
                        pass
                    return resp

                effective_session_id = result.get("session_id", session_id)
                # Terminal "done" event — emit directly (we're on the
                # main event loop here, not a worker thread).  See git
                # commit 19308b974 for the SSE race rationale.
                event_queue.put_nowait({
                    "event": "done",
                    "data": {
                        "session_id": effective_session_id,
                        "usage": usage,
                    },
                })

                await event_queue.put(None)
                try:
                    await writer_task
                except Exception:
                    logger.debug("[%s] writer task error", self.name, exc_info=True)

        return resp

    async def _sse_writer(
        self,
        resp: "web.StreamResponse",
        queue: "asyncio.Queue[Optional[Dict[str, Any]]]",
    ) -> None:
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                event_type = item.get("event", "message")
                payload = json.dumps(item.get("data", {}), ensure_ascii=False)
                frame = f"event: {event_type}\ndata: {payload}\n\n".encode("utf-8")
                try:
                    await resp.write(frame)
                except (ConnectionResetError, asyncio.CancelledError):
                    return
                except Exception:
                    logger.debug("[%s] SSE write failed", self.name, exc_info=True)
                    return
        except asyncio.CancelledError:
            return

    # ── SPA shell ─────────────────────────────────────────────────────

    async def _handle_spa_index(self, request: "web.Request") -> "web.Response":
        if self._spa_index_path is None or not self._spa_index_path.is_file():
            return await self._handle_spa_shell(request)
        return web.Response(
            body=self._spa_index_path.read_bytes(),
            content_type="text/html",
            headers={"Cache-Control": "no-cache"},
        )

    async def _handle_spa_shell(self, request: "web.Request") -> "web.Response":
        """Fallback HTML when the SPA bundle isn't built.

        Production deployments build the SPA into ``gateway/web/_static``.
        Source checkouts that just want to poke at the API still see a
        useful page here.
        """
        return web.Response(
            text=(
                "<!doctype html><html><head><title>Hermes Multi-User Web Chat</title>"
                "<meta charset=\"utf-8\"></head><body>"
                "<h1>Hermes Multi-User Web Chat</h1>"
                "<p>The SPA bundle is not yet installed. The backend API "
                "is live; users with a new-api key can POST it to "
                "<code>/api/auth/login</code> to obtain a session cookie, "
                "then POST messages to <code>/api/chat</code> for a "
                "streaming response.</p>"
                "<p>See <code>/api/healthz</code> for a liveness probe.</p>"
                "</body></html>"
            ),
            content_type="text/html",
        )
