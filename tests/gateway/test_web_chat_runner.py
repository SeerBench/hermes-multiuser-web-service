"""Tests for ``gateway.web.chat_runner.WebChatAgentRunner``.

Mock-based contract tests — verify that the runner constructs AIAgent
with the right kwargs (user_id, platform, toolsets, callbacks) and
returns the right (result, usage) shape from ``run()``.  Live agent
behaviour is covered by the Stage-8 integration test.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from gateway.web.chat_runner import (
    WebChatAgentRunner,
    collect_usage,
    derive_session_id_from_history,
)


# ── Shared mocks for the gateway.run helpers ───────────────────────────────


def _patch_gateway_runtime(monkeypatch, *, toolsets=("file", "web_search", "memory")):
    """Patch the four ``gateway.run`` / ``hermes_cli.tools_config`` helpers
    that ``_create_agent`` reaches into.  Returns the toolsets list the
    runner will see, so tests can assert agent kwargs.

    We import each helper through gateway.run / hermes_cli.tools_config and
    patch with monkeypatch so the chat_runner's lazy `from gateway.run
    import …` inside the function picks them up.
    """
    fake_runtime = {
        "api_key": "fake-key",
        "base_url": "https://fake.example/v1",
        "provider": "fake",
        "api_mode": "chat_completions",
        "command": None,
        "args": [],
        "credential_pool": None,
    }

    monkeypatch.setattr(
        "gateway.run._resolve_runtime_agent_kwargs", lambda: dict(fake_runtime)
    )
    monkeypatch.setattr(
        "gateway.run._resolve_gateway_model", lambda config=None: "fake-model"
    )
    monkeypatch.setattr("gateway.run._load_gateway_config", lambda: {})
    monkeypatch.setattr(
        "gateway.run.GatewayRunner._load_reasoning_config",
        lambda: None,
    )
    monkeypatch.setattr(
        "gateway.run.GatewayRunner._load_fallback_model",
        lambda: None,
    )
    monkeypatch.setattr(
        "hermes_cli.tools_config._get_platform_tools",
        lambda config, platform: set(toolsets),
    )

    return list(toolsets)


# ── _create_agent ────────────────────────────────────────────────────────


def test_create_agent_passes_user_id_to_aiagent(monkeypatch):
    _patch_gateway_runtime(monkeypatch)
    captured_kwargs = {}

    def fake_aiagent(**kwargs):
        captured_kwargs.update(kwargs)
        return MagicMock(name="agent")

    monkeypatch.setattr("run_agent.AIAgent", fake_aiagent)

    runner = WebChatAgentRunner()
    runner._create_agent(user_id="u_alice", session_id="s1")

    assert captured_kwargs["user_id"] == "u_alice"
    assert captured_kwargs["platform"] == "web_chat"
    assert captured_kwargs["session_id"] == "s1"
    # quiet_mode / verbose_logging defaults match api_server.py mirror
    assert captured_kwargs["quiet_mode"] is True
    assert captured_kwargs["verbose_logging"] is False


def test_create_agent_uses_web_chat_toolset_whitelist(monkeypatch):
    """The toolset list comes from `_get_platform_tools(config, "web_chat")`
    — distinct from api_server's "api_server" key.  Stage 4B configures
    what actually goes in this list (no terminal etc.); the runner just
    queries by platform name.
    """
    expected_tools = _patch_gateway_runtime(
        monkeypatch, toolsets=("web_file", "web_search", "memory")
    )
    captured_kwargs = {}
    monkeypatch.setattr(
        "run_agent.AIAgent",
        lambda **kw: (captured_kwargs.update(kw), MagicMock(name="agent"))[1],
    )

    # Capture the platform arg passed to _get_platform_tools.
    seen = {}

    def fake_get_platform_tools(config, platform):
        seen["platform"] = platform
        return set(expected_tools)

    monkeypatch.setattr(
        "hermes_cli.tools_config._get_platform_tools", fake_get_platform_tools
    )

    WebChatAgentRunner()._create_agent(user_id="u_alice")

    assert seen["platform"] == "web_chat"
    assert sorted(captured_kwargs["enabled_toolsets"]) == sorted(expected_tools)


def test_create_agent_passes_credentials_from_runtime_kwargs(monkeypatch):
    """LLM credentials are global (one upstream key shared by all users);
    they come from `_resolve_runtime_agent_kwargs`, not per-user state.
    """
    _patch_gateway_runtime(monkeypatch)
    captured = {}
    monkeypatch.setattr(
        "run_agent.AIAgent",
        lambda **kw: (captured.update(kw), MagicMock())[1],
    )

    WebChatAgentRunner()._create_agent(user_id="u_alice")

    assert captured["api_key"] == "fake-key"
    assert captured["base_url"] == "https://fake.example/v1"
    assert captured["provider"] == "fake"


def test_create_agent_wires_callbacks(monkeypatch):
    _patch_gateway_runtime(monkeypatch)
    captured = {}
    monkeypatch.setattr(
        "run_agent.AIAgent",
        lambda **kw: (captured.update(kw), MagicMock())[1],
    )

    stream_cb = MagicMock(name="stream")
    tp_cb = MagicMock(name="tool_progress")
    ts_cb = MagicMock(name="tool_start")
    tc_cb = MagicMock(name="tool_complete")

    WebChatAgentRunner()._create_agent(
        user_id="u_alice",
        stream_delta_callback=stream_cb,
        tool_progress_callback=tp_cb,
        tool_start_callback=ts_cb,
        tool_complete_callback=tc_cb,
    )

    assert captured["stream_delta_callback"] is stream_cb
    assert captured["tool_progress_callback"] is tp_cb
    assert captured["tool_start_callback"] is ts_cb
    assert captured["tool_complete_callback"] is tc_cb


def test_create_agent_uses_injected_session_db(monkeypatch):
    _patch_gateway_runtime(monkeypatch)
    captured = {}
    monkeypatch.setattr(
        "run_agent.AIAgent",
        lambda **kw: (captured.update(kw), MagicMock())[1],
    )

    sentinel_db = SimpleNamespace(_id="sentinel-session-db")
    runner = WebChatAgentRunner(session_db=sentinel_db)
    runner._create_agent(user_id="u_alice")

    assert captured["session_db"] is sentinel_db


def test_create_agent_passes_gateway_session_key(monkeypatch):
    """Stable per-channel key for long-term memory scope (Honcho etc.).
    Mirrors api_server's `X-Hermes-Session-Key` handling.
    """
    _patch_gateway_runtime(monkeypatch)
    captured = {}
    monkeypatch.setattr(
        "run_agent.AIAgent",
        lambda **kw: (captured.update(kw), MagicMock())[1],
    )

    WebChatAgentRunner()._create_agent(
        user_id="u_alice", gateway_session_key="channel-42"
    )
    assert captured["gateway_session_key"] == "channel-42"


def test_create_agent_supports_model_name_override(monkeypatch):
    """If the runner is constructed with a custom model_name, that takes
    precedence over `_resolve_gateway_model()`.  Lets the platform expose
    a vanity name (e.g. "Hermes Agent") to clients while using a
    different actual model under the hood.
    """
    _patch_gateway_runtime(monkeypatch)
    captured = {}
    monkeypatch.setattr(
        "run_agent.AIAgent",
        lambda **kw: (captured.update(kw), MagicMock())[1],
    )

    runner = WebChatAgentRunner(model_name="vanity/name")
    runner._create_agent(user_id="u_alice")
    assert captured["model"] == "vanity/name"


# ── run() ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_run_returns_result_and_usage(monkeypatch):
    _patch_gateway_runtime(monkeypatch)

    fake_agent = MagicMock(name="agent")
    fake_agent.session_id = "s1"
    fake_agent.session_prompt_tokens = 120
    fake_agent.session_completion_tokens = 45
    fake_agent.session_total_tokens = 165
    fake_agent.run_conversation.return_value = {"final_response": "hi"}
    monkeypatch.setattr("run_agent.AIAgent", lambda **kw: fake_agent)

    result, usage = await WebChatAgentRunner().run(
        user_id="u_alice",
        user_message="hello",
        conversation_history=[],
        session_id="s1",
    )

    assert result["final_response"] == "hi"
    assert result["session_id"] == "s1"
    assert usage == {
        "input_tokens": 120,
        "output_tokens": 45,
        "total_tokens": 165,
    }


@pytest.mark.asyncio
async def test_run_stores_agent_reference_for_interrupt(monkeypatch):
    """SSE writer needs the agent instance to call .interrupt() on disconnect."""
    _patch_gateway_runtime(monkeypatch)
    fake_agent = MagicMock(name="agent")
    fake_agent.run_conversation.return_value = {"final_response": "ok"}
    fake_agent.session_id = "s1"
    monkeypatch.setattr("run_agent.AIAgent", lambda **kw: fake_agent)

    agent_ref: list = [None]
    await WebChatAgentRunner().run(
        user_id="u_alice",
        user_message="hi",
        conversation_history=[],
        session_id="s1",
        agent_ref=agent_ref,
    )
    assert agent_ref[0] is fake_agent


@pytest.mark.asyncio
async def test_run_passes_history_and_message(monkeypatch):
    _patch_gateway_runtime(monkeypatch)
    fake_agent = MagicMock(name="agent")
    fake_agent.run_conversation.return_value = {"final_response": "ok"}
    fake_agent.session_id = "s1"
    monkeypatch.setattr("run_agent.AIAgent", lambda **kw: fake_agent)

    history = [
        {"role": "user", "content": "earlier"},
        {"role": "assistant", "content": "ok"},
    ]
    await WebChatAgentRunner().run(
        user_id="u_alice",
        user_message="next",
        conversation_history=history,
        session_id="s1",
    )

    call_kwargs = fake_agent.run_conversation.call_args.kwargs
    assert call_kwargs["user_message"] == "next"
    assert call_kwargs["conversation_history"] == history


@pytest.mark.asyncio
async def test_run_propagates_upstream_key_contextvar_to_worker_thread(monkeypatch):
    """Regression for the "no-key-required" 401 incident.

    ``WebChatAgentRunner._create_agent`` runs in a worker thread via
    ``loop.run_in_executor``.  ``run_in_executor(None, fn)`` does NOT
    automatically copy the calling task's ContextVar context — so the
    runner has to wrap with ``contextvars.copy_context().run`` or every
    per-request ContextVar (including the encrypted upstream API key
    bound by ``enter_upstream_key``) silently reads its default
    ``None``, and the chat call falls back to the global
    ``"no-key-required"`` placeholder → HTTP 401 from the upstream
    LLM gateway on every turn.

    This test fails fast (before any real chat traffic) if a future
    refactor drops the ``ctx.run`` wrapping.
    """
    from gateway.web.upstream_key import enter_upstream_key, get_upstream_key

    _patch_gateway_runtime(monkeypatch)
    seen_key = {"value": "<NOT-CAPTURED>"}

    def fake_aiagent(**kwargs):
        # AIAgent is built inside the executor thread; reading the
        # contextvar here is the same surface the real chat_runner uses
        # when it injects the upstream key into runtime_kwargs.
        seen_key["value"] = get_upstream_key()
        agent = MagicMock(name="agent")
        agent.session_id = "s1"
        agent.run_conversation.return_value = {"final_response": "ok"}
        agent.session_prompt_tokens = 0
        agent.session_completion_tokens = 0
        agent.session_total_tokens = 0
        return agent

    monkeypatch.setattr("run_agent.AIAgent", fake_aiagent)

    with enter_upstream_key("sk-test-marker-1234567890"):
        await WebChatAgentRunner().run(
            user_id="u_alice",
            user_message="hi",
            conversation_history=[],
            session_id="s1",
        )

    assert seen_key["value"] == "sk-test-marker-1234567890", (
        "Upstream key ContextVar did NOT cross into the executor thread. "
        "WebChatAgentRunner.run must use contextvars.copy_context().run "
        "to wrap _run — see CLAUDE.md note #4."
    )


@pytest.mark.asyncio
async def test_run_injects_effective_session_id_on_compression(monkeypatch):
    """If the agent rotated session_id mid-turn (compression), the runner
    surfaces the new id in the result for the SSE/header layer to relay.
    """
    _patch_gateway_runtime(monkeypatch)
    fake_agent = MagicMock(name="agent")
    fake_agent.session_id = "s2_post_compress"  # rotated
    fake_agent.run_conversation.return_value = {"final_response": "ok"}
    monkeypatch.setattr("run_agent.AIAgent", lambda **kw: fake_agent)

    result, _ = await WebChatAgentRunner().run(
        user_id="u_alice",
        user_message="hi",
        conversation_history=[],
        session_id="s1_original",
    )
    assert result["session_id"] == "s2_post_compress"


# ── _resolve_runtime_agent_kwargs BYO mode ────────────────────────────────


def test_resolve_runtime_agent_kwargs_byo_only_synthesizes_config(monkeypatch):
    """BYO-key deployment (NEW_API_BASE_URL set, no global provider key
    configured) must not error out of ``_resolve_runtime_agent_kwargs``.
    Before this fix, the function called ``resolve_runtime_provider``
    first, that threw ``AuthError`` because no OPENAI/OPENROUTER/etc.
    key was set, and the whole web_chat platform refused to serve
    requests with "No inference provider configured" — even though
    every chat turn supplies the key per-request via
    ``enter_upstream_key``.
    """
    from hermes_cli.auth import AuthError
    from gateway.run import _resolve_runtime_agent_kwargs

    monkeypatch.setenv("NEW_API_BASE_URL", "https://gw.example.com")

    def _raise_auth_error():
        raise AuthError("No inference provider configured.")

    monkeypatch.setattr(
        "hermes_cli.runtime_provider.resolve_runtime_provider",
        _raise_auth_error,
    )

    cfg = _resolve_runtime_agent_kwargs()
    assert cfg["base_url"] == "https://gw.example.com/v1"
    assert cfg["api_mode"] == "chat_completions"
    assert cfg["provider"] == "custom"
    # The placeholder must be present (chat_runner overrides it from
    # the user's session key) — empty/None would crash AIAgent init.
    assert cfg["api_key"]


def test_resolve_runtime_agent_kwargs_non_byo_auth_error_still_raises(monkeypatch):
    """Counterpart to the BYO test: if NEW_API_BASE_URL is NOT set, an
    AuthError from the provider resolver must still propagate (and
    after trying the fallback chain).  Otherwise a misconfigured
    non-web_chat deployment would silently mint a config pointing at
    nothing.
    """
    from hermes_cli.auth import AuthError
    from gateway.run import _resolve_runtime_agent_kwargs

    monkeypatch.delenv("NEW_API_BASE_URL", raising=False)

    def _raise_auth_error():
        raise AuthError("No inference provider configured.")

    monkeypatch.setattr(
        "hermes_cli.runtime_provider.resolve_runtime_provider",
        _raise_auth_error,
    )
    monkeypatch.setattr(
        "gateway.run._try_resolve_fallback_provider",
        lambda: None,
    )

    with pytest.raises(RuntimeError, match="No inference provider"):
        _resolve_runtime_agent_kwargs()


# ── derive_session_id_from_history ────────────────────────────────────────


def test_derive_session_id_is_deterministic():
    a = derive_session_id_from_history("u_alice", "sys", "hello")
    b = derive_session_id_from_history("u_alice", "sys", "hello")
    assert a == b
    assert len(a) == 16


def test_derive_session_id_differs_across_users():
    """Same first message from two users → different session ids
    (prevents one user from accidentally landing on another's session
    via deterministic hash collision)."""
    alice = derive_session_id_from_history("u_alice", "sys", "hello")
    bob = derive_session_id_from_history("u_bob", "sys", "hello")
    assert alice != bob


def test_derive_session_id_differs_across_messages():
    a = derive_session_id_from_history("u_alice", "sys", "hello")
    b = derive_session_id_from_history("u_alice", "sys", "different start")
    assert a != b


def test_derive_session_id_differs_across_system_prompts():
    a = derive_session_id_from_history("u_alice", "sys1", "hello")
    b = derive_session_id_from_history("u_alice", "sys2", "hello")
    assert a != b


def test_derive_session_id_handles_none_system_prompt():
    sid = derive_session_id_from_history("u_alice", None, "hello")
    assert len(sid) == 16


# ── collect_usage ────────────────────────────────────────────────────────


def test_collect_usage_extracts_total_tokens():
    usage = {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}
    assert collect_usage({"final_response": "hi"}, usage) == 15


def test_collect_usage_defaults_to_zero():
    assert collect_usage({}, {}) == 0
