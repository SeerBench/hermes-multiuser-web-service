"""Web-chat-platform-specific AIAgent factory + runner.

Mirror of ``gateway.platforms.api_server.APIServerAdapter._create_agent``
and ``._run_agent``, **kept independent** so the ``web_chat`` platform
doesn't touch ``api_server.py``.  The two paths share runtime-config
resolvers (``_resolve_runtime_agent_kwargs``, ``_resolve_gateway_model``,
``_get_platform_tools``) but each constructs its own AIAgent and runs it
in its own thread executor.

Why the duplication
-------------------
``api_server.py`` is one of the most actively edited files in the
upstream repo.  Refactoring its ``_create_agent`` / ``_run_agent`` into a
shared module would create a permanent merge-conflict surface against
upstream.  We pay ~150 LOC of duplication to keep upstream sync friction
to zero — see ``../../.../plans/...kazoo.md`` Stage-3 (revised).

Key differences vs api_server.py:
- ``platform="web_chat"`` (not ``"api_server"``)
- ``user_id`` is **passed through** to ``AIAgent`` so the agent's
  ``_user_id`` is set; ``_ensure_db_session`` then writes the right
  ``user_id`` into ``sessions``.  api_server.py does not pass user_id
  (it's an OpenAI-compat surface with no user concept).
- Toolset whitelist comes from ``_get_platform_tools(config, "web_chat")``
  (configured separately in Stage 4B with no terminal / code_execution
  / browser by default).
- LLM credentials are read once from ``config.yaml`` /
  ``~/.hermes/.env`` via ``_resolve_runtime_agent_kwargs()`` and stay
  fixed across all users — every user shares the same upstream key.
  Quota / cost attribution is tracked separately by ``QuotaGate``.

The agent runs inside ``loop.run_in_executor(None, ...)``.  Python copies
the current ContextVar context into the worker thread automatically, so
the ``enter_user_context`` bindings set by the request handler — both
the workspace contextvar and the ``HERMES_HOME`` override — propagate
into ``AIAgent.run_conversation``.  This is the mechanism that makes
memory + session isolation work without touching any agent-internal code.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger("hermes.web.chat_runner")


class WebChatAgentRunner:
    """Stateless factory + runner for AIAgent instances behind ``web_chat``.

    Construct once per gateway-platform lifecycle (typically in
    ``gateway/platforms/web_chat.py``'s ``start()``), share across all
    requests.  Each request calls :meth:`run` with the user's identifying
    metadata; the runner spawns a fresh AIAgent inside an executor and
    returns the final result + token usage.
    """

    def __init__(self, *, session_db: Any = None, model_name: Optional[str] = None):
        # ``session_db`` may be None — if so, ``_create_agent`` falls
        # back to ``AIAgent`` defaults (the agent opens its own
        # SessionDB).  In practice the platform passes a long-lived
        # SessionDB instance for connection reuse.
        self._session_db = session_db
        # If the caller wants to override the displayed model name
        # (for ``/v1/models`` etc.), set this here.  Resolved per
        # request via _resolve_gateway_model() otherwise.
        self._model_name_override = model_name

    # ── Agent factory (mirror of api_server._create_agent) ──────────────

    def _create_agent(
        self,
        *,
        user_id: str,
        ephemeral_system_prompt: Optional[str] = None,
        session_id: Optional[str] = None,
        stream_delta_callback: Optional[Callable] = None,
        tool_progress_callback: Optional[Callable] = None,
        tool_start_callback: Optional[Callable] = None,
        tool_complete_callback: Optional[Callable] = None,
        gateway_session_key: Optional[str] = None,
    ) -> Any:
        """Construct an AIAgent for a single web_chat request.

        Reads runtime config (api_key / base_url / provider) via
        ``_resolve_runtime_agent_kwargs()`` — the same path
        ``api_server._create_agent`` uses — and overlays:

        - ``user_id``: passed straight through; ``AIAgent.__init__`` sets
          ``agent._user_id`` (see ``agent/agent_init.py:267``), which the
          stage-1 fix at ``run_agent.py:517`` now propagates into
          ``sessions.user_id``.
        - ``platform="web_chat"``: makes ``_get_platform_tools`` pick the
          web_chat toolset whitelist and lets the agent's session source
          column reflect the real platform.
        """
        from run_agent import AIAgent
        from gateway.run import (
            GatewayRunner,
            _load_gateway_config,
            _resolve_gateway_model,
            _resolve_runtime_agent_kwargs,
        )
        from hermes_cli.tools_config import _get_platform_tools

        runtime_kwargs = _resolve_runtime_agent_kwargs()
        reasoning_config = GatewayRunner._load_reasoning_config()
        model = self._model_name_override or _resolve_gateway_model()

        user_config = _load_gateway_config()
        enabled_toolsets = sorted(_get_platform_tools(user_config, "web_chat"))

        max_iterations = int(os.getenv("HERMES_MAX_ITERATIONS", "90"))

        fallback_model = GatewayRunner._load_fallback_model()

        agent = AIAgent(
            model=model,
            **runtime_kwargs,
            max_iterations=max_iterations,
            quiet_mode=True,
            verbose_logging=False,
            ephemeral_system_prompt=ephemeral_system_prompt or None,
            enabled_toolsets=enabled_toolsets,
            session_id=session_id,
            platform="web_chat",
            user_id=user_id,
            stream_delta_callback=stream_delta_callback,
            tool_progress_callback=tool_progress_callback,
            tool_start_callback=tool_start_callback,
            tool_complete_callback=tool_complete_callback,
            session_db=self._session_db,
            fallback_model=fallback_model,
            reasoning_config=reasoning_config,
            gateway_session_key=gateway_session_key,
        )
        return agent

    # ── Run-in-executor wrapper (mirror of api_server._run_agent) ───────

    async def run(
        self,
        *,
        user_id: str,
        user_message: str,
        conversation_history: List[Dict[str, str]],
        ephemeral_system_prompt: Optional[str] = None,
        session_id: Optional[str] = None,
        stream_delta_callback: Optional[Callable] = None,
        tool_progress_callback: Optional[Callable] = None,
        tool_start_callback: Optional[Callable] = None,
        tool_complete_callback: Optional[Callable] = None,
        agent_ref: Optional[list] = None,
        gateway_session_key: Optional[str] = None,
    ) -> Tuple[Dict[str, Any], Dict[str, int]]:
        """Create a fresh agent and drive one conversation turn.

        Returns ``(result_dict, usage_dict)`` where ``usage_dict`` has
        ``input_tokens`` / ``output_tokens`` / ``total_tokens`` —
        the chat handler hands these to :meth:`QuotaGate.record`.

        If ``agent_ref`` is a one-element list, the AIAgent instance is
        stored at ``agent_ref[0]`` before ``run_conversation`` begins so
        the SSE writer can call ``agent.interrupt()`` on client
        disconnect.

        ContextVars (the workspace + HERMES_HOME override set by
        ``enter_user_context``) propagate into the executor thread
        automatically — Python copies the current context on
        ``loop.run_in_executor`` submission.  No special arrangement
        needed here.
        """
        loop = asyncio.get_running_loop()

        def _run() -> Tuple[Dict[str, Any], Dict[str, int]]:
            agent = self._create_agent(
                user_id=user_id,
                ephemeral_system_prompt=ephemeral_system_prompt,
                session_id=session_id,
                stream_delta_callback=stream_delta_callback,
                tool_progress_callback=tool_progress_callback,
                tool_start_callback=tool_start_callback,
                tool_complete_callback=tool_complete_callback,
                gateway_session_key=gateway_session_key,
            )
            if agent_ref is not None:
                agent_ref[0] = agent

            effective_task_id = session_id or str(uuid.uuid4())
            result = agent.run_conversation(
                user_message=user_message,
                conversation_history=conversation_history,
                task_id=effective_task_id,
            )
            usage = {
                "input_tokens": getattr(agent, "session_prompt_tokens", 0) or 0,
                "output_tokens": getattr(agent, "session_completion_tokens", 0) or 0,
                "total_tokens": getattr(agent, "session_total_tokens", 0) or 0,
            }
            # Track compression-triggered session rotations (#16938 parity
            # with api_server).
            eff_sid = getattr(agent, "session_id", session_id)
            if isinstance(eff_sid, str) and eff_sid:
                result["session_id"] = eff_sid
            return result, usage

        return await loop.run_in_executor(None, _run)


def derive_session_id_from_history(
    user_id: str,
    system_prompt: Optional[str],
    first_user_message: str,
) -> str:
    """Deterministic session ID for stateless requests.

    Web-chat clients that don't track ``session_id`` themselves (e.g.
    SPA that just sends conversation_history every turn) can be mapped
    to a stable session by hashing the user_id + system_prompt + first
    user message.  This mirrors api_server's session-id derivation but
    folds ``user_id`` into the hash so different users sending the same
    first message land on different sessions.

    Returns a 16-char hex string suitable for use as a ``session_id``.
    """
    import hashlib

    h = hashlib.sha256()
    h.update(user_id.encode("utf-8"))
    h.update(b"\x00")
    h.update((system_prompt or "").encode("utf-8"))
    h.update(b"\x00")
    h.update(first_user_message.encode("utf-8"))
    return h.hexdigest()[:16]


def collect_usage(result: Dict[str, Any], usage: Dict[str, int]) -> int:
    """Extract the token count to record against quota.

    Centralised so the chat handler doesn't have to know whether to use
    ``total_tokens`` (current api_server semantics — input + output) or
    just output tokens.  Hermes' upstream billing uses ``total_tokens``,
    so we follow suit; SPA usage meter shows the same value.

    ``result`` is forwarded for future use (e.g. if we want to bill
    differently when ``result["interrupted"]`` is True).
    """
    _ = result
    return int(usage.get("total_tokens", 0))
