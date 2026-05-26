"""Slash-command dispatcher for the multi-user web chat platform.

The CLI / Telegram / Discord / Slack platforms share a slash-command
registry at :data:`hermes_cli.commands.COMMAND_REGISTRY`.  Their
dispatch logic lives in :func:`gateway.run._handle_commands_command`,
which is built around the :class:`MessageEvent` abstraction (per-platform
inbound/outbound message pair).

The ``web_chat`` platform has its own request/response shape (JSON POST
→ JSON response), which doesn't fit that abstraction; and Strategy 2
forbids editing ``gateway/run.py``.  So this module re-implements
dispatch for the small subset of commands that actually make sense in
a web UI: session-level mutations (rename, undo) and read-only info
queries (status, usage, whoami).

Anything that requires a terminal (prompt-toolkit completions, clipboard
access, real interactive flows) is rejected with ``supported=False`` so
the SPA can render a "not yet available here" hint instead of breaking.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from hermes_cli.commands import COMMAND_REGISTRY, resolve_command


# ── Capability tables ──────────────────────────────────────────────────────

# CommandDef.name values that this dispatcher *implements* server-side.
# Any other registry entry without ``cli_only`` still appears in the
# popover, marked ``supported=False`` so the SPA can grey it out.
_SERVER_SUPPORTED: tuple[str, ...] = (
    "title",
    "undo",
    "status",
    "usage",
    "whoami",
)


# Commands the SPA implements entirely on the client (no HTTP round-trip).
# Surface them through ``list_commands`` so the popover knows about them
# and tags them ``client_only=True``.
_CLIENT_ONLY: tuple[Dict[str, str], ...] = (
    {"name": "clear", "category": "Session",
     "description_en": "Clear the current transcript view",
     "description_zh": "清空当前对话视图(不删除服务器历史)",
     "args_hint": ""},
    {"name": "new", "category": "Session",
     "description_en": "Start a new conversation",
     "description_zh": "开始一个新对话",
     "args_hint": ""},
    {"name": "help", "category": "Info",
     "description_en": "Show available commands",
     "description_zh": "显示可用命令",
     "args_hint": ""},
    {"name": "lang", "category": "Configuration",
     "description_en": "Switch UI language",
     "description_zh": "切换界面语言",
     "args_hint": "[en|zh]"},
    {"name": "retry", "category": "Session",
     "description_en": "Resend your last message",
     "description_zh": "重新发送上一条消息",
     "args_hint": ""},
)


# ── Result type ────────────────────────────────────────────────────────────


@dataclass
class CommandResult:
    """What a dispatched command returns to the HTTP layer."""

    ok: bool
    message: str
    status: int = 200
    side_effects: Dict[str, Any] = field(default_factory=dict)


# ── Catalog ────────────────────────────────────────────────────────────────


def list_commands() -> List[Dict[str, Any]]:
    """Build the JSON-ready command catalog for ``GET /api/commands``.

    Returns one entry per command available in web chat — both
    server-supported (real dispatch) and client-only (the SPA handles it).
    Pure ``cli_only`` registry entries are omitted entirely since they
    require terminal affordances we can't provide.
    """
    out: List[Dict[str, Any]] = []
    seen: set[str] = set()

    for entry in _CLIENT_ONLY:
        out.append({
            "name": entry["name"],
            "description": entry["description_en"],
            "description_i18n": {
                "en": entry["description_en"],
                "zh": entry["description_zh"],
            },
            "category": entry["category"],
            "args_hint": entry.get("args_hint", ""),
            "aliases": [],
            "subcommands": [],
            "client_only": True,
            "supported": True,
        })
        seen.add(entry["name"])

    for cmd in COMMAND_REGISTRY:
        if cmd.cli_only:
            continue
        if cmd.name in seen:
            continue
        out.append({
            "name": cmd.name,
            "description": cmd.description,
            "description_i18n": {"en": cmd.description, "zh": cmd.description},
            "category": cmd.category,
            "args_hint": cmd.args_hint or "",
            "aliases": list(cmd.aliases or ()),
            "subcommands": list(cmd.subcommands or ()),
            "client_only": False,
            "supported": cmd.name in _SERVER_SUPPORTED,
        })

    return out


# ── Dispatch ───────────────────────────────────────────────────────────────


def dispatch(
    name: str,
    args: str = "",
    *,
    user_id: str,
    session_id: Optional[str],
    db: Any,
) -> CommandResult:
    """Run a single slash command against the SessionDB.

    ``name`` may include or omit the leading slash. ``args`` is the
    free-form rest of the command line (everything after the first
    whitespace).  ``db`` is a :class:`hermes_state.SessionDB`.

    Returns a :class:`CommandResult`; the HTTP handler converts it to
    a JSON response with the appropriate status code.
    """
    raw = (name or "").strip().lstrip("/").lower()
    if not raw:
        return CommandResult(ok=False, message="command name required", status=400)

    # Client-only commands shouldn't reach the server, but if the SPA
    # ever fat-fingers a request, tell it cleanly.
    for entry in _CLIENT_ONLY:
        if raw == entry["name"]:
            return CommandResult(
                ok=False,
                message=f"/{raw} is handled by the web UI itself",
                status=400,
            )

    cmd = resolve_command(raw)
    if cmd is None:
        return CommandResult(
            ok=False,
            message=f"unknown command: /{raw}",
            status=404,
        )

    canonical = cmd.name
    if cmd.cli_only:
        return CommandResult(
            ok=False,
            message=f"/{canonical} is only available in the CLI",
            status=405,
        )
    if canonical not in _SERVER_SUPPORTED:
        return CommandResult(
            ok=False,
            message=f"/{canonical} is not yet available in web chat",
            status=405,
        )

    args = (args or "").strip()

    if canonical == "title":
        return _cmd_title(args, user_id=user_id, session_id=session_id, db=db)
    if canonical == "undo":
        return _cmd_undo(user_id=user_id, session_id=session_id, db=db)
    if canonical == "status":
        return _cmd_status(user_id=user_id, session_id=session_id, db=db)
    if canonical == "usage":
        return _cmd_usage(user_id=user_id, session_id=session_id, db=db)
    if canonical == "whoami":
        return _cmd_whoami(user_id=user_id, db=db)

    return CommandResult(ok=False, message="not implemented", status=501)


# ── Per-command handlers ───────────────────────────────────────────────────


def _require_own_session(
    db: Any, session_id: Optional[str], user_id: str,
) -> tuple[Optional[Dict[str, Any]], Optional[CommandResult]]:
    """Fetch a session and verify ``user_id`` owns it.

    Returns ``(session_row, error)``.  Exactly one is non-None.
    """
    if not session_id:
        return None, CommandResult(
            ok=False, message="no active session", status=400,
        )
    try:
        sess = db.get_session(session_id)
    except Exception as exc:
        return None, CommandResult(
            ok=False, message=f"db error: {exc}", status=500,
        )
    if not sess or sess.get("user_id") != user_id:
        return None, CommandResult(
            ok=False, message="session not found", status=404,
        )
    return sess, None


def _cmd_title(
    args: str, *, user_id: str, session_id: Optional[str], db: Any,
) -> CommandResult:
    sess, err = _require_own_session(db, session_id, user_id)
    if err is not None:
        return err
    if not args:
        return CommandResult(
            ok=True,
            message=sess.get("title") or "(no title)",
            side_effects={"title": sess.get("title"), "session_id": session_id},
        )
    try:
        ok = db.set_session_title(session_id, args)
    except Exception as exc:
        return CommandResult(
            ok=False, message=f"failed to set title: {exc}", status=500,
        )
    if not ok:
        return CommandResult(ok=False, message="failed to set title", status=500)
    return CommandResult(
        ok=True,
        message=f"title set: {args}",
        side_effects={"title": args, "session_id": session_id},
    )


def _cmd_undo(
    *, user_id: str, session_id: Optional[str], db: Any,
) -> CommandResult:
    _sess, err = _require_own_session(db, session_id, user_id)
    if err is not None:
        return err
    try:
        msgs = db.get_messages(session_id)
    except Exception as exc:
        return CommandResult(
            ok=False, message=f"failed to read messages: {exc}", status=500,
        )
    cut = len(msgs)
    # Drop everything after (and including) the last user turn.
    while cut > 0 and msgs[cut - 1].get("role") != "user":
        cut -= 1
    if cut == 0:
        return CommandResult(ok=False, message="nothing to undo", status=400)
    cut -= 1  # drop the user message itself too
    removed = len(msgs) - cut
    try:
        db.replace_messages(session_id, msgs[:cut])
    except Exception as exc:
        return CommandResult(
            ok=False, message=f"undo failed: {exc}", status=500,
        )
    return CommandResult(
        ok=True,
        message=f"removed {removed} message{'s' if removed != 1 else ''}",
        side_effects={"removed": removed, "session_id": session_id},
    )


def _cmd_status(
    *, user_id: str, session_id: Optional[str], db: Any,
) -> CommandResult:
    if not session_id:
        return CommandResult(
            ok=True,
            message="no active session",
            side_effects={"session_id": None},
        )
    sess, err = _require_own_session(db, session_id, user_id)
    if err is not None:
        return err
    title = sess.get("title") or session_id
    message_count = sess.get("message_count", 0)
    started_at = sess.get("started_at")
    lines = [
        f"session: {title}",
        f"messages: {message_count}",
    ]
    if started_at:
        lines.append(f"started_at: {started_at}")
    return CommandResult(
        ok=True,
        message="\n".join(lines),
        side_effects={
            "session_id": session_id,
            "title": sess.get("title"),
            "message_count": message_count,
            "started_at": started_at,
        },
    )


def _cmd_usage(
    *, user_id: str, session_id: Optional[str], db: Any,
) -> CommandResult:
    sess, err = _require_own_session(db, session_id, user_id)
    if err is not None:
        return err
    input_tokens = int(sess.get("input_tokens") or 0)
    output_tokens = int(sess.get("output_tokens") or 0)
    reasoning_tokens = int(sess.get("reasoning_tokens") or 0)
    total = input_tokens + output_tokens
    lines = [
        f"input tokens:     {input_tokens}",
        f"output tokens:    {output_tokens}",
    ]
    if reasoning_tokens:
        lines.append(f"reasoning tokens: {reasoning_tokens}")
    lines.append(f"total:            {total}")
    return CommandResult(
        ok=True,
        message="\n".join(lines),
        side_effects={
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "reasoning_tokens": reasoning_tokens,
            "total_tokens": total,
        },
    )


def _cmd_whoami(*, user_id: str, db: Any) -> CommandResult:
    return CommandResult(
        ok=True,
        message=f"user_id: {user_id}\nplatform: web_chat",
        side_effects={"user_id": user_id, "platform": "web_chat"},
    )
