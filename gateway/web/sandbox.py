"""Per-user filesystem sandbox and HERMES_HOME override.

The web_chat platform binds two ContextVars at the start of every request:

1. ``_USER_WORKSPACE`` — the user's workspace root
   (``$HERMES_HOME/web_workspaces/<user_id>/``).  Sandboxed tools
   (see :mod:`gateway.web.tools.sandboxed_file_operations`) read this and
   refuse any path that escapes it.

2. ``HERMES_HOME`` override (via :func:`hermes_constants.
   set_hermes_home_override`) — points at the user's workspace so the
   AIAgent's memory provider, session DB lookups, plugin caches, etc.
   all land under that subdir.  This is the **zero-touch memory
   isolation** path: ``MemoryManager`` and every memory provider read
   ``get_hermes_home()`` to decide where to store ``MEMORY.md`` /
   ``USER.md`` / Honcho cache, so overriding the env answer is enough.

:func:`enter_user_context` is the single entry point — sets both
contextvars on enter, resets both on exit.  Reentrancy-safe (Token-based
reset).  Importantly, ``state.db`` is **not** redirected: web users share
the same SQLite session store, isolated by the ``user_id`` column added
in the stage-1 fixes.

Defensive posture: :func:`confine_path` raises if called outside a user
context.  The sandboxed tools opt in by calling it; we never silently
"fall back to no sandbox".

Write rule: a user may only create/modify/delete files under their own
``web_workspaces/<user_id>/`` (which is also their HERMES_HOME override).
Paths outside that tree — including sibling users and the process
``HERMES_HOME`` — are rejected.
"""

from __future__ import annotations

import logging
import os
import re
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Iterator, Optional

from hermes_constants import (
    reset_hermes_home_override,
    reset_terminal_cwd_override,
    set_hermes_home_override,
    set_terminal_cwd_override,
)

logger = logging.getLogger("hermes.web.sandbox")

# Active per-request workspace.  Reset on exit_user_context — never leaks
# between concurrent requests because ContextVars are asyncio-task-local.
_USER_WORKSPACE: ContextVar[Optional[Path]] = ContextVar(
    "_USER_WORKSPACE", default=None
)

# Canonical layout inside a user workspace.  The web_chat platform
# enforces these subdirs exist on first request; sandboxed tools rely on
# them.
_USER_SUBDIRS = ("memories", "files", "cache", "skills", "uploads")

# user_id used as a single path segment under web_workspaces/.
_SAFE_USER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class PathSandboxViolation(PermissionError):
    """Raised when a path resolves outside the active user workspace."""


def process_hermes_home() -> Path:
    """Process-wide Hermes home, **ignoring** the per-user ContextVar override.

    ``enter_user_context`` redirects ``get_hermes_home()`` to the user
    workspace.  Workspace *layout* (``web_workspaces/<uid>/``) must stay
    anchored at the operator-configured ``HERMES_HOME`` env (or
    ``~/.hermes``), otherwise nested contexts nest directories incorrectly.
    """
    env_home = os.environ.get("HERMES_HOME", "").strip()
    if env_home:
        return Path(env_home)
    return Path.home() / ".hermes"


def workspaces_root() -> Path:
    """Parent directory for all user workspaces (process HERMES_HOME)."""
    return process_hermes_home() / "web_workspaces"


def assert_safe_user_id(user_id: str) -> str:
    """Reject path separators / traversal in ``user_id`` path segments."""
    uid = (user_id or "").strip()
    if not uid or not _SAFE_USER_ID.match(uid):
        raise ValueError(f"invalid user_id: {user_id!r}")
    return uid


def workspace_for(user_id: str) -> Path:
    """Path the workspace *would* live at — no I/O, no mkdir."""
    return workspaces_root() / assert_safe_user_id(user_id)


def ensure_workspace(user_id: str, *, base: Optional[Path] = None) -> Path:
    """Create the workspace + canonical subdirs if missing.  Idempotent."""
    uid = assert_safe_user_id(user_id)
    if base is None:
        base = workspaces_root()
    ws = base / uid
    for sub in _USER_SUBDIRS:
        (ws / sub).mkdir(parents=True, exist_ok=True)
    return ws


def get_user_workspace() -> Optional[Path]:
    """Return the active per-request workspace, or None outside a request."""
    return _USER_WORKSPACE.get()


def confine_path(path: "str | Path") -> Path:
    """Resolve ``path`` and reject if it escapes the active user workspace.

    Resolves with ``strict=False`` so writes to non-existent files work.
    The workspace itself is also resolved so symlinks at the workspace
    boundary behave symmetrically.  Raises:

    - :class:`RuntimeError` if called outside a user context.  Tools that
      opt into confinement assume the contextvar is set — silent
      fallback would defeat the security property.
    - :class:`PathSandboxViolation` if the resolved path is not inside
      the resolved workspace.

    Returns the resolved (absolute) path on success — callers should
    use this resolved path for the subsequent I/O.
    """
    ws = _USER_WORKSPACE.get()
    if ws is None:
        raise RuntimeError(
            "confine_path() called outside a web user context. "
            "The web_chat platform must wrap requests in enter_user_context()."
        )
    ws_resolved = Path(ws).resolve(strict=False)
    # Relative paths resolve against the *workspace*, not the process CWD.
    # The tool schemas advertise "relative to workspace" and the agent (and
    # the attachment-reference convention, ``uploads/<name>``) rely on that;
    # resolving against CWD would silently push every relative path outside
    # the sandbox and reject it.  Absolute paths are confined as-is, so this
    # neither weakens the ``..`` / sibling-workspace guards nor changes the
    # behaviour of the existing absolute-path callers.
    requested = Path(path).expanduser()
    if not requested.is_absolute():
        requested = ws_resolved / requested
    target = requested.resolve(strict=False)
    try:
        target.relative_to(ws_resolved)
    except ValueError:
        raise PathSandboxViolation(
            f"path {str(path)!r} escapes user workspace {ws_resolved}"
        ) from None
    return target


def unlink_storage_key(storage_key: str) -> bool:
    """Unlink a workspace-relative ``storage_key`` if it confines safely.

    Returns True if a file was removed.  Escaping keys are ignored (no
    unlink) so a poisoned DB row cannot delete sibling-user files.
    Must be called inside :func:`enter_user_context`.
    """
    try:
        path = confine_path(storage_key)
    except PathSandboxViolation:
        logger.warning(
            "refusing to unlink escaping storage_key=%r", storage_key
        )
        return False
    if path.is_file():
        path.unlink()
        return True
    return False


@contextmanager
def enter_user_context(
    user_id: str,
    *,
    workspaces_base: Optional[Path] = None,
) -> Iterator[Path]:
    """Bind workspace + HERMES_HOME to ``user_id`` for the current task.

    Use as ``async with`` is **not** supported — this is a sync context
    manager because the underlying ContextVar operations are sync.  In
    aiohttp handlers, wrap each request body in:

        with enter_user_context(user_id) as ws:
            ... await handler ...

    On exit, both contextvars are reset.  ContextVars are propagated to
    coroutines / threads spawned inside the ``with`` block (asyncio
    handles this automatically), so AIAgent callbacks running in
    ``asyncio.to_thread`` see the correct workspace + HERMES_HOME.

    Yields the resolved workspace ``Path``.
    """
    ws = ensure_workspace(user_id, base=workspaces_base)
    home_token = set_hermes_home_override(ws)
    cwd_token = set_terminal_cwd_override(ws)
    workspace_token = _USER_WORKSPACE.set(ws)
    try:
        yield ws
    finally:
        # Reset in reverse order of acquisition to be tidy, though
        # ContextVar resets are independent.
        _USER_WORKSPACE.reset(workspace_token)
        reset_terminal_cwd_override(cwd_token)
        reset_hermes_home_override(home_token)
