"""Multi-user web chat platform adapter.

HTTP gateway adapter for the self-hosted multi-user web service.  Wires
together everything from ``gateway/web/``:

- ``UserStore`` for accounts, API keys, browser sessions, quota
- ``make_auth_middleware`` for cookie + Bearer auth
- ``enter_user_context`` to bind workspace + ``HERMES_HOME`` per request
- ``QuotaGate`` for preflight 429 + post-flight token recording
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
POST        /api/auth/register         create user + initial API key + cookie
POST        /api/auth/login            verify password, set cookie
POST        /api/auth/logout           expire cookie
GET         /api/keys                  list keys (no plaintext)
POST        /api/keys                  sign a new key, plaintext returned ONCE
DELETE      /api/keys/{key_id}         revoke a key
GET         /api/conversations         list user's sessions
GET         /api/usage                 current quota state
POST        /api/chat                  SSE stream of agent response
GET         /api/healthz               public health probe
GET         /static/...                SPA static assets (stage 6)
GET         /                          SPA shell (stage 6 placeholder)
==========  =========================  =================================

SSE event protocol (``/api/chat`` only)
---------------------------------------

The chat handler responds with ``text/event-stream`` and emits the
following ``event:``-tagged frames, each with a JSON ``data:`` body:

- ``token``      — incremental assistant token delta
- ``tool_start`` — a tool call began
- ``tool_end``   — a tool call finished
- ``reasoning``  — model reasoning text (when the provider exposes it)
- ``done``       — final summary, includes ``session_id`` + ``usage``
                   + ``quota`` state
- ``error``      — fatal error before ``done``

The protocol is UI-friendly rather than OpenAI-compat: per-event
discrimination via the SSE ``event:`` field, structured payloads.
External OpenAI-compat clients should keep using
``gateway/platforms/api_server.py``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import socket as _socket
import time
import uuid
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

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
    get_request_user_id,
    install_user_store,
    issue_session_cookie,
    make_auth_middleware,
)
from gateway.web.chat_runner import WebChatAgentRunner, collect_usage
from gateway.web.quota import QuotaGate, attach_quota_headers
from gateway.web.sandbox import enter_user_context
from gateway.web.users import (
    DuplicateEmailError,
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
    instantiating ``WebChatAdapter``.  argon2-cffi is required (for
    UserStore); aiohttp is shared with api_server.
    """
    if not AIOHTTP_AVAILABLE:
        return False
    try:
        import argon2  # noqa: F401
    except ImportError:
        return False
    return True


# ── Adapter ────────────────────────────────────────────────────────────────


class WebChatAdapter(BasePlatformAdapter):
    """Self-hosted multi-user web chat platform.

    Lifecycle (driven by ``GatewayRunner``):
    1. ``__init__`` — construct from ``PlatformConfig``; instantiate
       ``UserStore`` (opens / creates ``web_users.db``) and
       ``WebChatAgentRunner``.
    2. ``connect()`` — build aiohttp app, wire routes + middleware,
       bind socket, start listening.
    3. ``disconnect()`` — graceful shutdown of the aiohttp runner and
       close ``UserStore``.

    All chat traffic is request/response — there is no inbound stream
    of "messages" to receive, so ``send()`` is unused (mirrors
    api_server.py's stub).
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
        # secure=False is necessary for local-dev HTTP; production must
        # set ``platforms.web_chat.cookie_secure: true`` (or wrap in TLS
        # reverse proxy).
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

        # ── Concurrency limit ──
        # Bounded by an asyncio.Semaphore to prevent N concurrent users
        # from all spinning up AIAgent instances at once on a small VPS.
        # Defaults to 12 (sized for 2c/4G — see plan capacity table).
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

        # ── Sub-systems (constructed lazily in connect so __init__ stays
        # cheap and side-effect free — UserStore opens a SQLite file).
        self._user_store: Optional[UserStore] = None
        self._quota: Optional[QuotaGate] = None
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
                "[%s] aiohttp and/or argon2-cffi not installed — install "
                "the [web-chat] extra to enable",
                self.name,
            )
            return False

        try:
            # Importing this package registers the sandboxed file tools
            # (web_file_read / web_file_write / web_file_patch /
            # web_file_search) via side effect.  Done here, not at
            # module top, so adapters that aren't enabled don't pay
            # the import cost.
            import gateway.web.tools  # noqa: F401

            self._user_store = UserStore()  # default path under HERMES_HOME
            self._quota = QuotaGate(self._user_store)
            self._session_db = self._ensure_session_db()
            self._runner = WebChatAgentRunner(session_db=self._session_db)
            self._agent_semaphore = asyncio.Semaphore(self._max_concurrent_agents)
        except Exception as exc:
            logger.error("[%s] failed to initialise subsystems: %s", self.name, exc)
            return False

        try:
            # Auth is the single middleware — body limits and CORS are
            # left to the front proxy in production; in dev the SPA and
            # API share an origin (Vite proxies /api → :8643), so CORS
            # isn't needed at this layer either.
            self._app = web.Application(
                middlewares=[make_auth_middleware()],
                client_max_size=MAX_REQUEST_BYTES,
            )
            install_user_store(self._app, self._user_store)
            self._wire_routes(self._app)

            # Refuse to bind a non-loopback host without HTTPS + secure
            # cookies, mirroring api_server.py's defensive posture.
            if self._is_network_accessible(self._host) and not self._cookie_secure:
                logger.error(
                    "[%s] refusing to bind %s without cookie_secure=true "
                    "(would send session cookies over plaintext HTTP)",
                    self.name, self._host,
                )
                return False

            # Port conflict — fail fast.
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
                "[%s] listening on http://%s:%d  (max_concurrent_agents=%d)",
                self.name, self._host, self._port, self._max_concurrent_agents,
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
        """Not used — web_chat is request/response, not push.

        Returns failure so any accidental call path is loud rather than
        silently dropped.  Mirrors api_server.py's stub.
        """
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
        app.router.add_post("/api/auth/register", self._handle_register)
        app.router.add_post("/api/auth/login", self._handle_login)
        app.router.add_post("/api/auth/logout", self._handle_logout)
        app.router.add_get("/api/keys", self._handle_list_keys)
        app.router.add_post("/api/keys", self._handle_create_key)
        app.router.add_delete("/api/keys/{key_id}", self._handle_revoke_key)
        app.router.add_get("/api/conversations", self._handle_list_conversations)
        app.router.add_get("/api/usage", self._handle_usage)
        app.router.add_post("/api/chat", self._handle_chat)
        # SPA shell + static assets — placeholder until stage 6.
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
        """Return a SessionDB instance, or None if unavailable.

        Mirrors api_server.py's lazy-init pattern.  Failure to open the
        session DB is non-fatal — the agent will fall back to per-call
        SessionDB creation.
        """
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

    async def _handle_register(self, request: "web.Request") -> "web.Response":
        try:
            body = await request.json()
        except Exception:
            return self._json_error("invalid JSON")
        email = (body.get("email") or "").strip()
        password = body.get("password") or ""
        if not email or not password:
            return self._json_error("email and password required")

        try:
            user_id, api_key = self._user_store.create_user(email, password)
        except DuplicateEmailError:
            return self._json_error("email already registered", status=409, code="duplicate_email")
        except UserStoreError as exc:
            return self._json_error(str(exc), status=400)

        cookie_token = self._user_store.create_web_session(
            user_id, ttl_seconds=self._cookie_ttl_seconds
        )
        resp = web.json_response({
            "user_id": user_id,
            "email": email,
            "api_key": api_key,  # only returned here — UI must show + offer copy
        })
        issue_session_cookie(
            resp, cookie_token,
            ttl_seconds=self._cookie_ttl_seconds,
            secure=self._cookie_secure,
        )
        logger.info("[%s] registered user_id=%s", self.name, user_id)
        return resp

    async def _handle_login(self, request: "web.Request") -> "web.Response":
        try:
            body = await request.json()
        except Exception:
            return self._json_error("invalid JSON")
        email = (body.get("email") or "").strip()
        password = body.get("password") or ""
        if not email or not password:
            return self._json_error("email and password required")

        try:
            user_id = self._user_store.verify_password(email, password)
        except InvalidCredentialsError:
            return self._json_error("bad credentials", status=401, code="bad_credentials")

        cookie_token = self._user_store.create_web_session(
            user_id, ttl_seconds=self._cookie_ttl_seconds
        )
        resp = web.json_response({"user_id": user_id, "email": email})
        issue_session_cookie(
            resp, cookie_token,
            ttl_seconds=self._cookie_ttl_seconds,
            secure=self._cookie_secure,
        )
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

    # ── /api/keys ──────────────────────────────────────────────────────

    async def _handle_list_keys(self, request: "web.Request") -> "web.Response":
        user_id = get_request_user_id(request)
        keys = self._user_store.list_api_keys(user_id)
        return web.json_response({"keys": keys})

    async def _handle_create_key(self, request: "web.Request") -> "web.Response":
        user_id = get_request_user_id(request)
        try:
            key_id, plaintext = self._user_store.create_api_key(user_id)
        except UserStoreError as exc:
            return self._json_error(str(exc), status=400)
        return web.json_response({
            "key_id": key_id,
            "api_key": plaintext,  # only here
        })

    async def _handle_revoke_key(self, request: "web.Request") -> "web.Response":
        user_id = get_request_user_id(request)
        key_id = request.match_info["key_id"]
        ok = self._user_store.revoke_api_key(key_id, user_id)
        if not ok:
            return self._json_error("key not found", status=404, code="key_not_found")
        return web.json_response({"ok": True, "key_id": key_id})

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

        # Project to a SPA-friendly shape.
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

    # ── /api/usage ─────────────────────────────────────────────────────

    async def _handle_usage(self, request: "web.Request") -> "web.Response":
        user_id = get_request_user_id(request)
        try:
            state = self._user_store.check_quota(user_id)
        except UserStoreError as exc:
            return self._json_error(str(exc), status=500)
        return web.json_response(state)

    # ── /api/chat ──────────────────────────────────────────────────────

    async def _handle_chat(self, request: "web.Request") -> "web.StreamResponse":
        user_id = get_request_user_id(request)

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

        # Quota preflight (also rolls the 30-day window if stale).
        try:
            quota_before = self._quota.preflight(user_id)
        except web.HTTPTooManyRequests as exc:
            # Only relay the X-Quota-* headers — leaving HTTPTooManyRequests'
            # default Content-Type in would collide with json_response's
            # own Content-Type setter.
            quota_headers = {
                name: value
                for name, value in exc.headers.items()
                if name.startswith("X-Quota-")
            }
            return web.json_response(
                {"error": "quota_exceeded", "quota": {
                    "used": int(quota_headers.get("X-Quota-Used", "0")),
                    "limit": int(quota_headers.get("X-Quota-Limit", "0")),
                    "remaining": int(quota_headers.get("X-Quota-Remaining", "0")),
                }},
                status=429,
                headers=quota_headers,
            )

        # Concurrency gate — protects shared resources (memory, CPU)
        # under load.  Holds the slot for the entire agent loop.
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
        attach_quota_headers(resp, quota_before)
        await resp.prepare(request)

        loop = asyncio.get_running_loop()
        # Event queue: agent-thread callbacks push events here via
        # call_soon_threadsafe; this coroutine drains and writes them.
        event_queue: asyncio.Queue[Optional[Dict[str, Any]]] = asyncio.Queue()

        def _push(event_type: str, payload: Dict[str, Any]) -> None:
            """Thread-safe push from the agent worker thread."""
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
        usage_recorded = False

        async with self._agent_semaphore:
            with enter_user_context(user_id):
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
                    # Client disconnected — interrupt the running agent.
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
                    # Sentinel to drain the writer.
                    await event_queue.put(None)
                    try:
                        await writer_task
                    except Exception:
                        pass
                    return resp
                finally:
                    # Record usage even on partial / interrupted runs.
                    # Pull what the agent collected so far (collect_usage
                    # is defensive about missing fields).
                    if not usage_recorded and agent_ref[0] is not None:
                        partial_usage = {
                            "total_tokens": getattr(
                                agent_ref[0], "session_total_tokens", 0
                            ) or 0,
                        }
                        try:
                            self._quota.record(
                                user_id, collect_usage({}, partial_usage)
                            )
                            usage_recorded = True
                        except Exception:
                            logger.debug(
                                "[%s] quota.record failed", self.name, exc_info=True,
                            )

                # Happy path: agent finished, record real usage, emit done.
                if not usage_recorded:
                    quota_after = self._quota.record(
                        user_id, collect_usage(result, usage),
                    )
                    usage_recorded = True
                else:
                    quota_after = self._user_store.check_quota(user_id)

                effective_session_id = result.get("session_id", session_id)
                _push("done", {
                    "session_id": effective_session_id,
                    "usage": usage,
                    "quota": quota_after,
                })

                # Sentinel — tells the writer to flush and exit cleanly.
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
        """Drain ``queue`` and write SSE frames until a None sentinel arrives.

        Each non-sentinel item is ``{"event": str, "data": Dict[str, Any]}``.
        Closes the response on disconnect or after the sentinel.
        """
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
                    # Client disconnected — let the outer handler clean up.
                    return
                except Exception:
                    logger.debug("[%s] SSE write failed", self.name, exc_info=True)
                    return
        except asyncio.CancelledError:
            return

    # ── SPA shell (placeholder until stage 6) ─────────────────────────

    async def _handle_spa_shell(self, request: "web.Request") -> "web.Response":
        """Serve the SPA index.

        Until stage 6 ships the React build, we serve a small placeholder
        explaining the API.  The auth middleware lets ``/`` through
        unauthenticated (it's the SPA entrypoint where login happens).
        """
        return web.Response(
            text=(
                "<!doctype html><html><head><title>Hermes Multi-User Web Chat</title>"
                "<meta charset=\"utf-8\"></head><body>"
                "<h1>Hermes Multi-User Web Chat</h1>"
                "<p>The SPA bundle is not yet installed.  The backend API "
                "is live; use any HTTP client to hit "
                "<code>POST /api/auth/register</code> to create an account "
                "and <code>POST /api/chat</code> to start a streaming "
                "conversation.</p>"
                "<p>See <code>/api/healthz</code> for a liveness probe.</p>"
                "</body></html>"
            ),
            content_type="text/html",
        )
