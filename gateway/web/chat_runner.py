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
import contextvars
import logging
import os
import time
import uuid
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger("hermes.web.chat_runner")


def _emit_agent_create_trace(
    user_id: str,
    model: str,
    session_id: Optional[str],
    enabled_toolsets: List[str],
) -> None:
    """Fork debug trace (necessary point) — one line per web_chat turn.

    Called from ``_create_agent`` while the per-user HERMES_HOME override is
    active (we run inside ``ctx.run``), so the web-backend gate is evaluated
    against *this* user's resolved config — the single most useful signal for
    the recurring "web_search not exposed?" hunt.  Writes one concise line per
    turn under ``./logs`` (see ``gateway/web/debug_log.py``) so it can be
    rsync'd off the test box and read / diff'd on the dev box.  Pairs with the
    ``outbound_tools.jsonl`` dump in ``agent/chat_completion_helpers.py``: this
    records what the *gate* decides at agent-construction time, that records
    what actually reaches the wire — together they localize where (if anywhere)
    ``web_search`` drops.

    Skipped under pytest (``PYTEST_CURRENT_TEST``) so the suite never writes
    diagnostics into the source tree (matches the convention in
    ``hermes_cli/auth.py``); the gateway runtime never sets that var, so the
    trace is effectively always-on in real deployments.  Best-effort — every
    failure is swallowed so a broken diagnostic can't break a chat turn.
    """
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return
    try:
        from gateway.web import debug_log as _debug_log
        from hermes_constants import get_hermes_home as _get_hermes_home

        try:
            # Mirror check_web_{search,extract}_available WITHOUT their WARNING
            # side effect: the registry gate already logs that on the real
            # tool-resolution pass; calling the gate here too would double the
            # warning every turn.  So we call the underlying resolvers and
            # reproduce the boolean ourselves.
            from tools.web_tools import (
                _get_search_backend as _gsb,
                _get_extract_backend as _geb,
                _is_backend_available as _iba,
            )

            search_backend = _gsb()
            extract_backend = _geb()
            search_ok: Optional[bool] = bool(_iba(search_backend))
            extract_ok: Optional[bool] = bool(_iba(extract_backend))
        except Exception as web_exc:
            search_backend = extract_backend = None
            search_ok = extract_ok = None
            logger.debug("web backend probe failed in trace: %r", web_exc)

        hh = str(_get_hermes_home())
        _debug_log.get_file_logger(
            "hermes.web.chat_runner.trace", "web_chat.log"
        ).info(
            "turn user=%s model=%s hermes_home=%s toolsets=%d "
            "web_search=%s(%s) web_extract=%s(%s)",
            user_id, model, hh, len(enabled_toolsets),
            search_ok, search_backend, extract_ok, extract_backend,
        )
        _debug_log.append_jsonl(
            "web_chat_tools.jsonl",
            {
                "event": "agent_create",
                "user": user_id,
                "model": model,
                "session_id": session_id,
                "hermes_home": hh,
                "toolsets": enabled_toolsets,
                "web_search_available": search_ok,
                "search_backend": search_backend,
                "web_extract_available": extract_ok,
                "extract_backend": extract_backend,
            },
        )
    except Exception as trace_exc:  # diagnostics must never break a turn
        logger.debug("web_chat debug trace failed: %r", trace_exc)


# Registry toolsets registered by ``gateway/web/tools`` at import time.  They are
# part of the ``hermes-web-chat`` composite but absent from static ``TOOLSETS``,
# so ``_get_platform_tools(config, "web_chat")`` drops them unless we merge back.
_FORK_WEB_CHAT_SANDBOX_TOOLSETS: frozenset[str] = frozenset({
    "web_file",
    "web_skill",
    "web_memory",
    "web_knowledge",
})


def _resolve_web_chat_enabled_toolsets(user_config: dict) -> list[str]:
    """Return enabled toolset names for web_chat, including fork sandbox sets.

    Generic ``_get_platform_tools`` reverse-maps only static CONFIGURABLE
    toolsets and misses dynamic registry toolsets such as ``web_file``.  Without
    this merge, ``web_file_read`` is registered but never exposed to the model.
    """
    from hermes_cli.tools_config import _get_platform_tools
    from toolsets import resolve_toolset
    from tools.registry import registry

    enabled = set(_get_platform_tools(user_config, "web_chat"))
    composite_tools = set(resolve_toolset("hermes-web-chat"))

    for ts_name in _FORK_WEB_CHAT_SANDBOX_TOOLSETS:
        ts_tools = set(registry.get_tool_names_for_toolset(ts_name))
        if ts_tools and ts_tools.issubset(composite_tools):
            enabled.add(ts_name)

    return sorted(enabled)


# Platform-level system-prompt addendum.  Appended ahead of any SPA-supplied
# ``system_prompt`` so the agent always knows what surface it is running on,
# what fork-specific tools exist, and how Brave / secrets are handled.
# Added 2026-05-27 after a session in which the agent — lacking these tools
# at the time and having no platform guidance — tried to "install" a Brave
# Search skill by instructing the user to paste an API key into chat and
# run shell commands.  See ``docs/plans/2026-05-26-per-user-skill-isolation.md``.
_WEB_PLATFORM_PROMPT_ADDENDUM = """\
[hermes-multiuser-web-service platform notes]

You are running inside a multi-user web service.  Every request is bound to
one authenticated user with a private workspace at ``<workspace>/skills/``.
That workspace overlays the operator-curated global library at
``$HERMES_HOME/skills/``; the user can see both, but can only write to their
own.

Per-user skill tools (use these instead of ``skill_*`` — those upstream tools
are intentionally absent here):

- ``web_skills_list`` — list available skills (user-private + global, merged).
  Call this first when the user asks to install, find, or use a skill.
- ``web_skill_view`` — read a skill's ``SKILL.md`` or a supporting file.
- ``web_skill_install`` — write a new ``SKILL.md`` (and optional supporting
  files) into the user's private skills dir.
- ``web_skill_delete`` — delete a user-private skill (global skills cannot
  be deleted from chat).
- ``web_skill_edit`` — rewrite a personal skill's ``SKILL.md``. Global-only
  skills are forked into the workspace first.
- ``web_skill_patch`` — targeted find-and-replace (preferred for habit-driven
  evolution). Also forks global-only skills before mutating.

Skill-install protocol (strict — these rules exist because a previous agent
violated them and the user lost trust):

1. **Installs ALWAYS go through ``web_skill_install``.**  Never instruct the
   user to run shell commands (``mkdir``, ``cat > … << EOF``, ``vi``, etc.)
   to create skill files themselves.  That bypasses the per-user sandbox,
   points at the wrong filesystem path, and may even leak credentials into
   their shell history.  If you don't have file-write permission for the
   destination, you don't have permission, period — surface the limitation,
   don't route around it through the user.
2. **Installs ALWAYS land in *this user's private skills directory*.**
   They are not visible to other users and they are not in the global
   library.  You cannot install into ``$HERMES_HOME/skills/`` from chat —
   that is an operator-side action, out of scope for you.
3. **If ``web_skill_install`` returns an error** (bad frontmatter, name
   collision, size cap, invalid category), surface the tool's error to the
   user verbatim and offer to fix the input.  Do NOT fall back to
   shell-install workarounds.
4. **``web_skill_delete`` refuses to remove global skills.**  Tell the user
   to ask the operator if they need a global skill gone.

Skills are Markdown documents with YAML frontmatter that *teach you how to
use existing tools*.  They are NOT runtime configuration files, and they
MUST NOT contain API keys, tokens, or any other user secret.  Never write a
SKILL.md that embeds credentials; if a user pastes one in chat, ask them to
rotate it and explain that secrets are configured server-side, not in chat.

Attachments:  When the user uploads files, they are saved into this user's
private workspace under ``uploads/`` and the chat message lists them by their
workspace-relative path (e.g. ``uploads/data.csv``).  Read them on demand with
``web_file_read`` (or search them with ``web_file_search``) using that relative
path — do not ask the user to paste file contents into chat.  Supported read
formats include plain text (``.txt``, ``.md``), PDF, Word (``.docx``), Excel
(``.xlsx``), and PowerPoint (``.pptx``).  When attachments are listed in the
user message, call ``web_file_read`` on those paths before answering questions
about their contents.

Web search:  The ``web_search`` tool is wired up for all users via the
operator-configured **ddgs** (DuckDuckGo) backend — zero extra API keys
required when ``[web-chat]`` is installed and ``web.search_backend: ddgs``
is set in server config.  Use ``web_search`` directly when the user asks
for current events or facts from the public web.  Paid providers (Brave,
Tavily, Firecrawl, Exa) are optional operator-side upgrades only.  Users
must NOT paste search-provider API keys into chat; if they do, refuse to
embed the key anywhere and tell them search is configured by the operator.

Images:  When you generate an image with ``image_generate``, the tool returns
the image as a URL in the result's ``image`` field.  You MUST surface it by
embedding that URL in your reply as Markdown — ``![<short description>](<url>)``
— on its own line.  This is not optional: on this web surface a generated
image is INVISIBLE to the user unless you inline it as Markdown; merely
describing the picture in prose shows them nothing.  Always paste the actual
``![...](<url>)`` (in addition to any caption), and never claim you "created"
or "attached" an image without including its Markdown link.
"""


def _workspace_runtime_prompt(*, workspace: Any, model: str) -> str:
    """Per-request facts the model must not invent from MEMORY.md / SOUL.md.

    ``workspace`` is the absolute path of the active user sandbox (bound by
    ``enter_user_context``).  File tools (``web_file_*``) are confined there;
    the process CWD of the gateway is never the user's working directory.
    """
    lines = [
        "[hermes-multiuser-web-service runtime]",
        f"Active model for this turn: {model}",
        "When asked which model you are using, report that id exactly — "
        "do not invent a different model from memory or identity files.",
    ]
    if workspace is not None:
        ws = str(workspace)
        lines.extend(
            [
                f"User workspace root (your only working directory): {ws}",
                "All file reads/writes/searches must use paths under this "
                "workspace via ``web_file_read`` / ``web_file_write`` / "
                "``web_file_patch`` / ``web_file_search``.  Relative paths "
                "resolve from the workspace root (e.g. ``uploads/data.csv``, "
                "``files/notes.md``).  ``web_file_read`` extracts text from "
                "PDF and Office documents (``.pdf``, ``.docx``, ``.xlsx``, "
                "``.pptx``) after sandbox confinement.  Never claim the gateway "
                "process CWD or the hermes-agent checkout is the user's directory.",
            ]
        )
    return "\n".join(lines)


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
        model_override: Optional[str] = None,
        stream_delta_callback: Optional[Callable] = None,
        tool_progress_callback: Optional[Callable] = None,
        tool_start_callback: Optional[Callable] = None,
        tool_complete_callback: Optional[Callable] = None,
        reasoning_callback: Optional[Callable] = None,
        status_callback: Optional[Callable] = None,
        step_callback: Optional[Callable] = None,
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
        from gateway.web.upstream_key import get_upstream_key

        runtime_kwargs = _resolve_runtime_agent_kwargs()
        # BYO-key mode: if the chat handler bound the end-user's upstream
        # API key into the contextvar, that user-specific key overrides
        # the globally-configured one so the LLM call is billed to the
        # right account at the new-api gateway.  When no key is bound
        # (gateway-spawned agent runs not behind a web_chat request),
        # the global config wins unchanged.
        upstream_key = get_upstream_key()
        if upstream_key:
            runtime_kwargs = {**runtime_kwargs, "api_key": upstream_key}
        reasoning_config = GatewayRunner._load_reasoning_config()
        model = (
            (model_override or "").strip()
            or self._model_name_override
            or _resolve_gateway_model()
        )

        user_config = _load_gateway_config()
        enabled_toolsets = _resolve_web_chat_enabled_toolsets(user_config)

        # Fork debug trace (necessary point) — one diagnostic line per turn
        # into ./logs, evaluated under this user's HERMES_HOME context.  See
        # the helper for the full rationale; it self-skips under pytest.
        _emit_agent_create_trace(user_id, model, session_id, enabled_toolsets)

        max_iterations = int(os.getenv("HERMES_MAX_ITERATIONS", "90"))

        fallback_model = GatewayRunner._load_fallback_model()

        # Platform-level addendum is always present; SPA-supplied prompt is
        # appended after so anything the user specifies overrides on conflict
        # (LLMs typically weight later instructions more heavily when they
        # disagree, and we want user intent to win).
        from gateway.web.sandbox import get_user_workspace

        workspace = get_user_workspace()
        runtime_block = _workspace_runtime_prompt(workspace=workspace, model=model)
        base_ephemeral = (
            _WEB_PLATFORM_PROMPT_ADDENDUM.strip() + "\n\n" + runtime_block
        )
        if ephemeral_system_prompt:
            effective_ephemeral = (
                base_ephemeral + "\n\n" + ephemeral_system_prompt
            ).strip()
        else:
            effective_ephemeral = base_ephemeral

        agent = AIAgent(
            model=model,
            **runtime_kwargs,
            max_iterations=max_iterations,
            quiet_mode=True,
            verbose_logging=False,
            ephemeral_system_prompt=effective_ephemeral,
            # Context files (AGENTS.md etc.) load from TERMINAL_CWD override
            # bound by enter_user_context — the user workspace, not process CWD.
            skip_context_files=False,
            enabled_toolsets=enabled_toolsets,
            session_id=session_id,
            platform="web_chat",
            user_id=user_id,
            stream_delta_callback=stream_delta_callback,
            tool_progress_callback=tool_progress_callback,
            tool_start_callback=tool_start_callback,
            tool_complete_callback=tool_complete_callback,
            reasoning_callback=reasoning_callback,
            status_callback=status_callback,
            step_callback=step_callback,
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
        reasoning_callback: Optional[Callable] = None,
        status_callback: Optional[Callable] = None,
        step_callback: Optional[Callable] = None,
        agent_ref: Optional[list] = None,
        gateway_session_key: Optional[str] = None,
        model_override: Optional[str] = None,
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
        ``enter_user_context``, plus the upstream API key set by
        ``enter_upstream_key``) must be carried into the executor
        thread explicitly: ``loop.run_in_executor(None, fn)`` does
        **not** copy the current context the way ``asyncio.to_thread``
        or ``asyncio.create_task`` do.  Without ``ctx.run`` wrapping,
        every ContextVar inside ``_run`` reads its default — which for
        ``upstream_key`` means ``None``, which silently dropped
        per-user keys and let the agent fall back to the global
        ``"no-key-required"`` placeholder.  The symptom was HTTP 401
        from the upstream LLM gateway on every chat turn (see commit
        message for the diagnostic that uncovered this).
        """
        loop = asyncio.get_running_loop()
        ctx = contextvars.copy_context()

        def _run() -> Tuple[Dict[str, Any], Dict[str, int]]:
            agent = self._create_agent(
                user_id=user_id,
                ephemeral_system_prompt=ephemeral_system_prompt,
                session_id=session_id,
                model_override=model_override,
                stream_delta_callback=stream_delta_callback,
                tool_progress_callback=tool_progress_callback,
                tool_start_callback=tool_start_callback,
                tool_complete_callback=tool_complete_callback,
                reasoning_callback=reasoning_callback,
                status_callback=status_callback,
                step_callback=step_callback,
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

        return await loop.run_in_executor(None, ctx.run, _run)


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
