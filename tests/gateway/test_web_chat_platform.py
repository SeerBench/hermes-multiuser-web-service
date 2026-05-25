"""End-to-end integration tests for the ``web_chat`` platform.

Stitches together stages 1-5 with a mocked AIAgent so we can verify
the **whole** request flow:

1. POST /api/auth/register — UserStore creates the user, cookie is set,
   plaintext API key is returned exactly once.
2. POST /api/chat — auth middleware resolves the cookie, ``enter_user_context``
   sets the workspace + HERMES_HOME override, WebChatAgentRunner is
   invoked, SSE stream returns ``token`` / ``tool_start`` / ``tool_end``
   / ``done`` frames, quota is recorded.
3. Quota: a second user starts with an independent counter; over-quota
   user gets 429.
4. Cross-user isolation: Alice and Bob each have their own sessions,
   keys, and quota.
5. SPA placeholder shell returns HTML at ``/``.

The real WebChatAgentRunner is mocked because spawning AIAgent inside
an executor pulls the full Hermes dependency tree (openai, pydantic,
provider plugins, etc.) which can't be made hermetic for a unit
suite.  Stage-4 adapter tests prove the wiring; this suite proves
the full HTTP flow including SSE serialization, cookie handling, and
per-user contextvar isolation across concurrent requests.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any, Dict, List, Tuple
from unittest.mock import patch

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from gateway.config import PlatformConfig
from gateway.platforms.web_chat import WebChatAdapter
from gateway.web.auth import (
    SESSION_COOKIE,
    install_user_store,
    make_auth_middleware,
)
from gateway.web.quota import QuotaGate
from gateway.web.users import UserStore


# ── Fake AIAgent runner ─────────────────────────────────────────────────────


class FakeRunner:
    """A WebChatAgentRunner stand-in that drives the SSE callbacks
    deterministically so tests can assert on the stream contents.
    """

    def __init__(self, *, tokens: List[str] = None, tools: List[Tuple[str, str]] = None):
        self.tokens = tokens or ["Hello", " ", "world"]
        self.tools = tools or []
        self.last_call_kwargs: Dict[str, Any] = {}

    async def run(self, **kwargs):
        self.last_call_kwargs = kwargs

        stream_cb = kwargs.get("stream_delta_callback")
        tool_start_cb = kwargs.get("tool_start_callback")
        tool_complete_cb = kwargs.get("tool_complete_callback")

        def emit():
            for tool_name, preview in self.tools:
                if tool_start_cb:
                    tool_start_cb(tool_name, preview)
                if tool_complete_cb:
                    tool_complete_cb(tool_name, duration=0.1, is_error=False)
            for tok in self.tokens:
                if stream_cb:
                    stream_cb(tok)

        # Run callbacks inside an executor so the contextvar
        # propagation path matches real life (Python copies the
        # current context into run_in_executor).
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, emit)

        result = {
            "final_response": "".join(self.tokens),
            "session_id": kwargs.get("session_id") or "web_test_session",
        }
        # Mirror real runner's token accounting on agent_ref so the
        # finally-block usage-record code in _handle_chat works.
        if kwargs.get("agent_ref") is not None:
            fake_agent = SimpleNamespace(
                session_total_tokens=42,
                session_prompt_tokens=20,
                session_completion_tokens=22,
                interrupt=lambda: None,
            )
            kwargs["agent_ref"][0] = fake_agent
        usage = {"input_tokens": 20, "output_tokens": 22, "total_tokens": 42}
        return result, usage


# ── Fixture: full adapter + aiohttp client ──────────────────────────────────


@pytest.fixture
def hermes_home(tmp_path, monkeypatch):
    home = tmp_path / "hermes_home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home


@pytest.fixture
async def harness(hermes_home):
    """Spin up a real WebChatAdapter app with FakeRunner instead of AIAgent."""
    config = PlatformConfig(enabled=True)
    adapter = WebChatAdapter(config)
    adapter._user_store = UserStore(hermes_home / "web_users.db")
    adapter._quota = QuotaGate(adapter._user_store)
    adapter._session_db = None
    adapter._runner = FakeRunner()
    adapter._agent_semaphore = asyncio.Semaphore(8)

    app = web.Application(middlewares=[make_auth_middleware()])
    install_user_store(app, adapter._user_store)
    adapter._wire_routes(app)

    async with TestClient(TestServer(app)) as client:
        yield SimpleNamespace(
            client=client,
            adapter=adapter,
            store=adapter._user_store,
            runner=adapter._runner,
        )
    adapter._user_store.close()


async def _register(client, email="alice@x.co", password="long enough password"):
    resp = await client.post(
        "/api/auth/register",
        json={"email": email, "password": password},
    )
    return resp


async def _read_sse_events(resp) -> List[Dict[str, Any]]:
    """Drain an SSE response into a list of decoded events."""
    import json as _json

    events: List[Dict[str, Any]] = []
    buffer = ""
    async for chunk in resp.content.iter_any():
        buffer += chunk.decode("utf-8")
        while "\n\n" in buffer:
            frame, buffer = buffer.split("\n\n", 1)
            event_type = "message"
            data = ""
            for line in frame.split("\n"):
                if line.startswith("event:"):
                    event_type = line.split(":", 1)[1].strip()
                elif line.startswith("data:"):
                    data = line.split(":", 1)[1].strip()
            if data:
                events.append({"event": event_type, "data": _json.loads(data)})
    return events


# ── End-to-end happy paths ─────────────────────────────────────────────────


async def test_register_then_chat_roundtrip(harness):
    reg = await _register(harness.client)
    assert reg.status == 200

    chat = await harness.client.post(
        "/api/chat",
        json={"message": "hello"},
    )
    assert chat.status == 200
    assert chat.headers["Content-Type"].startswith("text/event-stream")

    events = await _read_sse_events(chat)
    # Token frames in order
    tokens = [e for e in events if e["event"] == "token"]
    assert [t["data"]["text"] for t in tokens] == ["Hello", " ", "world"]

    # Terminal frame includes usage + quota
    done = [e for e in events if e["event"] == "done"]
    assert len(done) == 1
    assert done[0]["data"]["usage"]["total_tokens"] == 42
    assert done[0]["data"]["quota"]["used"] == 42

    # Quota headers attached to the response
    assert chat.headers["X-Quota-Used"] == "0"  # set at preflight time
    assert int(chat.headers["X-Quota-Remaining"]) > 0


async def test_chat_passes_user_id_to_runner(harness):
    reg = await _register(harness.client)
    user_id = (await reg.json())["user_id"]

    resp = await harness.client.post("/api/chat", json={"message": "hi"})
    await _read_sse_events(resp)
    # FakeRunner captured the kwargs of run()
    assert harness.runner.last_call_kwargs["user_id"] == user_id


async def test_chat_propagates_session_id_from_done(harness):
    await _register(harness.client)

    harness.runner.tokens = ["X"]
    resp = await harness.client.post(
        "/api/chat",
        json={"message": "hi", "session_id": "explicit-id"},
    )
    events = await _read_sse_events(resp)
    done = [e for e in events if e["event"] == "done"][0]
    assert done["data"]["session_id"] == "explicit-id"


async def test_chat_emits_tool_events(harness):
    await _register(harness.client)

    harness.runner.tools = [("web_search", "find tokyo weather")]
    harness.runner.tokens = ["sunny"]

    resp = await harness.client.post("/api/chat", json={"message": "weather?"})
    events = await _read_sse_events(resp)

    types = [e["event"] for e in events]
    assert "tool_start" in types
    assert "tool_end" in types
    tool_start = next(e for e in events if e["event"] == "tool_start")
    assert tool_start["data"]["tool"] == "web_search"
    assert tool_start["data"]["preview"] == "find tokyo weather"


# ── Quota enforcement ──────────────────────────────────────────────────────


async def test_chat_records_usage_against_quota(harness):
    reg = await _register(harness.client)
    user_id = (await reg.json())["user_id"]

    initial = harness.store.check_quota(user_id)
    assert initial["used"] == 0

    resp = await harness.client.post("/api/chat", json={"message": "hi"})
    # Drain the SSE body — client.post returns as soon as headers
    # land, but quota.record runs in the server's finally block which
    # only fires after the stream completes.
    await _read_sse_events(resp)

    after = harness.store.check_quota(user_id)
    assert after["used"] == 42  # FakeRunner reports total_tokens=42


async def test_chat_429_when_over_quota_preflight(harness):
    reg = await _register(harness.client)
    user_id = (await reg.json())["user_id"]
    harness.store.set_quota_limit(user_id, 0)

    resp = await harness.client.post("/api/chat", json={"message": "hi"})
    assert resp.status == 429
    body = await resp.json()
    assert body["error"] == "quota_exceeded"


# ── Cross-user isolation ───────────────────────────────────────────────────


async def test_two_users_see_independent_quota(harness):
    # Alice consumes some quota
    alice_reg = await _register(harness.client, email="alice@x.co")
    alice_id = (await alice_reg.json())["user_id"]
    resp = await harness.client.post("/api/chat", json={"message": "hi"})
    await _read_sse_events(resp)

    # Bob logs in (fresh cookie via register)
    harness.client.session.cookie_jar.clear()
    bob_reg = await _register(harness.client, email="bob@x.co")
    bob_id = (await bob_reg.json())["user_id"]

    assert harness.store.check_quota(alice_id)["used"] > 0
    assert harness.store.check_quota(bob_id)["used"] == 0


async def test_keys_endpoint_is_user_scoped(harness):
    await _register(harness.client, email="alice@x.co")
    alice_keys = (await (await harness.client.get("/api/keys")).json())["keys"]
    assert len(alice_keys) == 1
    alice_key_id = alice_keys[0]["key_id"]

    harness.client.session.cookie_jar.clear()
    await _register(harness.client, email="bob@x.co")
    bob_keys = (await (await harness.client.get("/api/keys")).json())["keys"]
    bob_key_ids = {k["key_id"] for k in bob_keys}
    assert alice_key_id not in bob_key_ids


async def test_bearer_token_chat_works_for_non_browser_clients(harness):
    reg = await _register(harness.client)
    api_key = (await reg.json())["api_key"]

    # Drop the cookie to force Bearer auth only
    harness.client.session.cookie_jar.clear()

    resp = await harness.client.post(
        "/api/chat",
        json={"message": "hi"},
        headers={"Authorization": f"Bearer {api_key}"},
    )
    assert resp.status == 200
    events = await _read_sse_events(resp)
    assert any(e["event"] == "done" for e in events)


# ── HERMES_HOME / workspace isolation ──────────────────────────────────────


async def test_chat_creates_user_workspace_dir(harness, hermes_home):
    reg = await _register(harness.client)
    user_id = (await reg.json())["user_id"]

    resp = await harness.client.post("/api/chat", json={"message": "hi"})
    await _read_sse_events(resp)

    ws = hermes_home / "web_workspaces" / user_id
    assert ws.is_dir()
    assert (ws / "memories").is_dir()
    assert (ws / "files").is_dir()


async def test_two_users_get_distinct_workspaces(harness, hermes_home):
    alice_reg = await _register(harness.client, email="alice@x.co")
    alice_id = (await alice_reg.json())["user_id"]
    resp = await harness.client.post("/api/chat", json={"message": "hi"})
    await _read_sse_events(resp)

    harness.client.session.cookie_jar.clear()
    bob_reg = await _register(harness.client, email="bob@x.co")
    bob_id = (await bob_reg.json())["user_id"]
    resp = await harness.client.post("/api/chat", json={"message": "hi"})
    await _read_sse_events(resp)

    assert (hermes_home / "web_workspaces" / alice_id).is_dir()
    assert (hermes_home / "web_workspaces" / bob_id).is_dir()
    assert alice_id != bob_id


# ── SPA shell ──────────────────────────────────────────────────────────────


async def test_spa_shell_is_public(harness):
    resp = await harness.client.get("/")
    assert resp.status == 200
    text = await resp.text()
    assert "Hermes Multi-User Web Chat" in text or "<html" in text.lower()


# ── Concurrent isolation (the heart of the multi-user contract) ────────────


async def test_concurrent_requests_dont_swap_user_contexts(harness):
    """Two simultaneous chat requests from different users must each
    end up with their own user_id reaching the runner.

    The risk being tested: if contextvars were threadlocals rather
    than asyncio-task-local, Alice's request could land in Bob's
    workspace.  We verify by inspecting which user_id the FakeRunner
    saw last for each request.
    """
    # Register Alice + Bob, get bearer tokens for both.
    alice_reg = await _register(harness.client, email="alice@x.co")
    alice_id = (await alice_reg.json())["user_id"]
    alice_key = (await alice_reg.json())["api_key"]
    harness.client.session.cookie_jar.clear()
    bob_reg = await _register(harness.client, email="bob@x.co")
    bob_id = (await bob_reg.json())["user_id"]
    bob_key = (await bob_reg.json())["api_key"]

    # Per-request runner that records the user_id it saw.
    seen: List[str] = []

    class TrackingRunner(FakeRunner):
        async def run(self, **kwargs):
            seen.append(kwargs["user_id"])
            return await super().run(**kwargs)

    harness.adapter._runner = TrackingRunner()

    async def fire(api_key):
        resp = await harness.client.post(
            "/api/chat",
            json={"message": "hi"},
            headers={"Authorization": f"Bearer {api_key}"},
        )
        await _read_sse_events(resp)

    # Drop cookies so Bearer is the only auth.
    harness.client.session.cookie_jar.clear()

    await asyncio.gather(fire(alice_key), fire(bob_key))

    assert sorted(seen) == sorted([alice_id, bob_id])
