"""Sandboxed file tools for the ``web_chat`` platform.

Each tool here mirrors a tool from ``tools/file_tools.py`` but wraps
the upstream public function with a :func:`gateway.web.sandbox.
confine_path` check on every path argument.  Paths that resolve
outside ``$HERMES_HOME/web_workspaces/<user_id>/`` are rejected with a
JSON error (the tool-result shape AIAgent expects), without ever
reaching the underlying disk operation.

The upstream ``read_file_tool`` / ``write_file_tool`` / ``patch_tool``
/ ``search_tool`` are imported and called as-is — we do **not** copy
or fork their implementation.  Cost is one path-resolution per tool
call; benefit is zero churn against ``tools/file_tools.py`` upstream.

Tool naming: ``web_file_read``, ``web_file_write``, ``web_file_patch``,
``web_file_search``.  Distinct from the upstream ``read_file`` etc.
so AIAgent can see both (or only one, via toolset whitelist) without
collision.  The ``hermes-web-chat`` toolset in ``toolsets.py`` lists
only these names, so the upstream variants are not exposed on this
platform.

Contextvar dependency
---------------------
``confine_path`` raises ``RuntimeError`` if called outside an active
user context.  ``gateway/platforms/web_chat.py::_handle_chat`` wraps
every request in ``enter_user_context`` before invoking the agent, so
the tools always run inside one.  Outside that — e.g. if someone
enables ``web_file_*`` for a non-web platform by mistake — the tool
will surface ``RuntimeError`` as a hard error rather than silently
operating outside the sandbox.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Callable, Dict

from gateway.web.sandbox import PathSandboxViolation, confine_path
from tools.file_operations import normalize_read_pagination
from tools.file_tools import (
    patch_tool,
    read_file_tool,
    search_tool,
    write_file_tool,
)
from tools.registry import registry

logger = logging.getLogger("hermes.web.tools.sandboxed_file_operations")

_TOOLSET = "web_file"

# Office/PDF: upstream read_file_tool rejects these as binary; extract text instead.
_EXTRACTABLE_SUFFIXES = frozenset({".pdf", ".docx", ".xlsx", ".pptx"})
_MAX_EXTRACT_CHARS = 100_000


def _confine_or_error(path: str) -> "str | Dict[str, Any]":
    """Resolve ``path`` against the active user workspace.

    Returns the resolved absolute path on success, or a tool-error
    dict ready to be JSON-encoded on rejection.  Hides the absolute
    workspace path from the agent's error string so the model doesn't
    learn the host filesystem layout.
    """
    try:
        return str(confine_path(path))
    except PathSandboxViolation as exc:
        logger.info("web_file: rejected out-of-sandbox path %r (%s)", path, exc)
        return {
            "success": False,
            "error": (
                "path is outside your workspace. "
                "Use relative paths or paths under your workspace root."
            ),
            "rejected_path": path,
        }
    except RuntimeError as exc:
        # confine_path raised because no user context is active.  This
        # is a server-side programming error (the chat handler should
        # always be inside enter_user_context), not user input.
        logger.error("web_file: no user context active: %s", exc)
        return {
            "success": False,
            "error": "internal sandbox not initialised",
        }


def _json_or_passthrough(value: Any) -> str:
    """Tool handlers must return ``str``.  Upstream functions already
    return str (JSON or formatted text); our rejection dicts need
    encoding here.
    """
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


def _format_line_window(
    lines: list[str],
    offset: int,
    limit: int,
) -> tuple[str, int, int, int]:
    """Return numbered content window, total lines, normalized offset/limit."""
    norm_offset, norm_limit = normalize_read_pagination(offset, limit)
    total = len(lines)
    start = max(0, norm_offset - 1)
    end = min(total, start + norm_limit)
    numbered = [f"{idx}|{line}" for idx, line in enumerate(lines[start:end], start=start + 1)]
    return "\n".join(numbered), total, norm_offset, norm_limit


def _read_extractable_document(confined_path: str, offset: int, limit: int) -> str:
    """Extract text from PDF/Office and paginate like ``read_file_tool``."""
    from platform_api.services.extract import extract_text

    path = Path(confined_path)
    if not path.is_file():
        return json.dumps(
            {"success": False, "error": f"file not found: {path.name}"},
            ensure_ascii=False,
        )
    try:
        text = extract_text(path)
    except ValueError as exc:
        return json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False)
    except Exception as exc:
        logger.warning("web_file_read extract failed for %s: %s", path.name, exc)
        return json.dumps(
            {"success": False, "error": f"failed to extract text: {exc}"},
            ensure_ascii=False,
        )

    lines = text.splitlines()
    if not lines and text:
        lines = [text]
    if not lines:
        return json.dumps(
            {
                "success": True,
                "path": path.name,
                "content": "",
                "total_lines": 0,
                "offset": 1,
                "limit": limit,
                "extracted": True,
            },
            ensure_ascii=False,
        )

    content, total_lines, norm_offset, norm_limit = _format_line_window(lines, offset, limit)
    if len(content) > _MAX_EXTRACT_CHARS:
        return json.dumps(
            {
                "success": False,
                "error": (
                    f"Extracted content exceeds safety limit ({_MAX_EXTRACT_CHARS:,} chars). "
                    "Use offset and limit to read a smaller range."
                ),
                "total_lines": total_lines,
            },
            ensure_ascii=False,
        )

    return json.dumps(
        {
            "success": True,
            "path": path.name,
            "content": content,
            "total_lines": total_lines,
            "offset": norm_offset,
            "limit": norm_limit,
            "extracted": True,
        },
        ensure_ascii=False,
    )


# ── Handlers ───────────────────────────────────────────────────────────────


def _handle_web_file_read(args: Dict[str, Any], **kw: Any) -> str:
    confined = _confine_or_error(args.get("path", ""))
    if isinstance(confined, dict):
        return _json_or_passthrough(confined)
    suffix = Path(confined).suffix.lower()
    if suffix in _EXTRACTABLE_SUFFIXES:
        return _read_extractable_document(
            confined,
            args.get("offset", 1),
            args.get("limit", 500),
        )
    return read_file_tool(
        path=confined,
        offset=args.get("offset", 1),
        limit=args.get("limit", 500),
        task_id=kw.get("task_id") or "default",
    )


def _handle_web_file_write(args: Dict[str, Any], **kw: Any) -> str:
    if not args.get("path") or not isinstance(args.get("path"), str):
        return _json_or_passthrough({
            "success": False,
            "error": "web_file_write: missing required field 'path'",
        })
    if "content" not in args or not isinstance(args["content"], str):
        return _json_or_passthrough({
            "success": False,
            "error": "web_file_write: missing or non-string 'content'",
        })

    confined = _confine_or_error(args["path"])
    if isinstance(confined, dict):
        return _json_or_passthrough(confined)

    return write_file_tool(
        path=confined,
        content=args["content"],
        task_id=kw.get("task_id") or "default",
    )


def _handle_web_file_patch(args: Dict[str, Any], **kw: Any) -> str:
    mode = args.get("mode", "replace")

    if mode == "replace":
        path = args.get("path")
        if not path:
            return _json_or_passthrough({
                "success": False,
                "error": "web_file_patch (replace mode) requires 'path'",
            })
        confined = _confine_or_error(path)
        if isinstance(confined, dict):
            return _json_or_passthrough(confined)
        return patch_tool(
            mode="replace",
            path=confined,
            old_string=args.get("old_string"),
            new_string=args.get("new_string"),
            replace_all=args.get("replace_all", False),
            task_id=kw.get("task_id") or "default",
        )

    if mode == "patch":
        # V4A multi-file patch — we can't trivially confine every
        # filename referenced inside the patch payload without parsing
        # the V4A format.  Reject ``mode='patch'`` on the web platform
        # to keep the security model simple; users get ``replace``
        # mode (single-file, path-explicit) which is sufficient for
        # the common case.
        return _json_or_passthrough({
            "success": False,
            "error": (
                "web_file_patch: V4A 'patch' mode is not allowed in the "
                "web sandbox (cannot confine paths inside the patch "
                "payload). Use mode='replace' with explicit path + "
                "old_string + new_string."
            ),
        })

    return _json_or_passthrough({
        "success": False,
        "error": f"web_file_patch: unknown mode {mode!r}",
    })


def _handle_web_file_search(args: Dict[str, Any], **kw: Any) -> str:
    # ``search_files`` accepts ``path`` (default ".") — confine it so
    # the search can never recurse outside the workspace.  If the
    # caller passes ".", the active workspace root is used.
    path = args.get("path") or "."
    if path == ".":
        # Implicit "current directory" → user workspace root.
        try:
            from gateway.web.sandbox import get_user_workspace
            ws = get_user_workspace()
            if ws is None:
                return _json_or_passthrough({
                    "success": False,
                    "error": "internal sandbox not initialised",
                })
            confined = str(ws)
        except Exception as exc:  # defensive
            return _json_or_passthrough({
                "success": False,
                "error": f"could not resolve workspace: {exc}",
            })
    else:
        result = _confine_or_error(path)
        if isinstance(result, dict):
            return _json_or_passthrough(result)
        confined = result

    target_map = {"grep": "content", "find": "files"}
    raw_target = args.get("target", "content")
    target = target_map.get(raw_target, raw_target)
    return search_tool(
        pattern=args.get("pattern", ""),
        target=target,
        path=confined,
        file_glob=args.get("file_glob"),
        limit=args.get("limit", 50),
        offset=args.get("offset", 0),
        output_mode=args.get("output_mode", "content"),
        context=args.get("context", 0),
        task_id=kw.get("task_id") or "default",
    )


# ── Schemas ────────────────────────────────────────────────────────────────


_SANDBOX_NOTE = (
    " All paths are confined to your per-user workspace; paths that "
    "escape via '..' or absolute paths outside it are rejected."
)


_WEB_FILE_READ_SCHEMA = {
    "name": "web_file_read",
    "description": (
        "Read a file in your workspace with line numbers and pagination. "
        "Plain text (``.txt``, ``.md``) is read directly; PDF and Office "
        "documents (``.pdf``, ``.docx``, ``.xlsx``, ``.pptx``) are text-"
        "extracted first. Mirrors `read_file` but sandboxed." + _SANDBOX_NOTE
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Path to the file (relative to workspace, or absolute under workspace).",
            },
            "offset": {
                "type": "integer",
                "description": "Line number to start from (1-indexed, default 1).",
                "default": 1,
                "minimum": 1,
            },
            "limit": {
                "type": "integer",
                "description": "Max lines to read (default 500, max 2000).",
                "default": 500,
                "maximum": 2000,
            },
        },
        "required": ["path"],
    },
}


_WEB_FILE_WRITE_SCHEMA = {
    "name": "web_file_write",
    "description": (
        "Write content to a file in your workspace, replacing existing "
        "content. Creates parent directories automatically. Mirrors "
        "`write_file` but sandboxed." + _SANDBOX_NOTE
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Path to the file."},
            "content": {"type": "string", "description": "Complete file content."},
        },
        "required": ["path", "content"],
    },
}


_WEB_FILE_PATCH_SCHEMA = {
    "name": "web_file_patch",
    "description": (
        "Targeted find-and-replace in a workspace file. Uses fuzzy "
        "matching; returns a unified diff. Only `mode='replace'` is "
        "supported in the web sandbox (V4A multi-file patches are "
        "blocked because their inner paths cannot be confined)."
        + _SANDBOX_NOTE
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "mode": {
                "type": "string",
                "enum": ["replace"],
                "description": "Edit mode. Only 'replace' is allowed in the web sandbox.",
                "default": "replace",
            },
            "path": {"type": "string", "description": "File path to edit."},
            "old_string": {
                "type": "string",
                "description": "Exact text to replace. Must be unique unless replace_all=true.",
            },
            "new_string": {
                "type": "string",
                "description": "Replacement text. Pass '' to delete the matched text.",
            },
            "replace_all": {
                "type": "boolean",
                "description": "Replace all occurrences (default false).",
                "default": False,
            },
        },
        "required": ["mode", "path", "old_string", "new_string"],
    },
}


_WEB_FILE_SEARCH_SCHEMA = {
    "name": "web_file_search",
    "description": (
        "Search workspace file contents (target='content', ripgrep "
        "regex) or find files by glob (target='files'). Mirrors "
        "`search_files` but sandboxed; search root never escapes "
        "your workspace." + _SANDBOX_NOTE
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "pattern": {
                "type": "string",
                "description": "Regex pattern for content search, or glob for file search.",
            },
            "target": {
                "type": "string",
                "enum": ["content", "files"],
                "description": "'content' searches inside files; 'files' searches by name.",
                "default": "content",
            },
            "path": {
                "type": "string",
                "description": "Directory to search in. Default '.' (your workspace root).",
                "default": ".",
            },
            "file_glob": {
                "type": "string",
                "description": "Filter files by pattern in content mode (e.g. '*.py').",
            },
            "limit": {
                "type": "integer",
                "description": "Max results (default 50).",
                "default": 50,
            },
            "offset": {
                "type": "integer",
                "description": "Pagination offset (default 0).",
                "default": 0,
            },
            "output_mode": {
                "type": "string",
                "enum": ["content", "files_only", "count"],
                "description": "Output format for content mode.",
                "default": "content",
            },
            "context": {
                "type": "integer",
                "description": "Context lines around each match (content mode).",
                "default": 0,
            },
        },
        "required": ["pattern"],
    },
}


# ── Registration ───────────────────────────────────────────────────────────


_REGISTRATIONS: tuple[tuple[str, Dict[str, Any], Callable], ...] = (
    ("web_file_read", _WEB_FILE_READ_SCHEMA, _handle_web_file_read),
    ("web_file_write", _WEB_FILE_WRITE_SCHEMA, _handle_web_file_write),
    ("web_file_patch", _WEB_FILE_PATCH_SCHEMA, _handle_web_file_patch),
    ("web_file_search", _WEB_FILE_SEARCH_SCHEMA, _handle_web_file_search),
)


def _register_all() -> None:
    """Idempotent registration — safe if module is imported twice."""
    for name, schema, handler in _REGISTRATIONS:
        try:
            registry.register(
                name=name,
                toolset=_TOOLSET,
                schema=schema,
                handler=handler,
                max_result_size_chars=100_000,
            )
        except Exception:
            # Already-registered errors are not fatal — we just want
            # this side effect to fire once per process.
            logger.debug("re-registering %s", name, exc_info=True)


_register_all()
