"""Fork-only debug-log helper — centralizes ad-hoc diagnostics under ``./logs``.

Why this module exists
----------------------
Upstream's centralized logging (``hermes_logging.setup_logging``) writes
``agent.log`` / ``errors.log`` / ``gateway.log`` under ``<HERMES_HOME>/logs``
(i.e. ``~/.hermes/logs``).  That is the right home for the long-lived gateway's
operational logs, but it is awkward when you are debugging the **test server**
from a **separate dev box**:

1. ``~/.hermes/logs`` lives outside the repo, so it is not part of the tree you
   ``rsync`` / ``scp`` between the two machines.
2. The throwaway artifacts a hunt produces (the outbound-tools dump, the
   per-turn tool-resolution trace) don't belong mixed into the operator's real
   ``agent.log``.

So fork-side **diagnostic** artifacts land in ``<repo_root>/logs`` instead —
one predictable, repo-relative directory you can pull off the test box and
``jq`` / ``diff`` locally.  ``logs/`` is already ``.gitignore``d, so this never
pollutes git.

Override the location with ``HERMES_DEBUG_LOG_DIR`` (an absolute path) if you
want the artifacts elsewhere (a tmpfs on a constrained box, a shared mount, …).
``agent/chat_completion_helpers.py``'s temporary outbound-tools dump honors the
same env var and the same default, so all fork diagnostics stay together.

Everything here is **best-effort and never raises into a real request**: a
broken debug sink must never break a chat turn.  Repo-root is resolved from
``__file__`` (``gateway/web/debug_log.py`` → ``parents[2]``), which is correct
for the editable install this fork always uses for dev/test; if you ever run
from a non-editable wheel, set ``HERMES_DEBUG_LOG_DIR`` explicitly.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

# ``gateway/web/debug_log.py`` → parents[0]=web, [1]=gateway, [2]=repo root.
_REPO_ROOT = Path(__file__).resolve().parents[2]

# One lock guards both the JSONL appends (so concurrent web_chat agent threads
# never interleave a line) and the lazy FileHandler creation in
# ``get_file_logger`` (so two threads don't race-attach two handlers).
_LOCK = threading.Lock()
_LOGGERS: Dict[str, logging.Logger] = {}
_FALLBACK = logging.getLogger("hermes.web.debug_log")


def log_dir() -> Path:
    """Return (creating if needed) the centralized fork debug-log directory.

    ``HERMES_DEBUG_LOG_DIR`` overrides; otherwise ``<repo_root>/logs``.
    """
    override = (os.getenv("HERMES_DEBUG_LOG_DIR") or "").strip()
    base = Path(override).expanduser() if override else (_REPO_ROOT / "logs")
    base.mkdir(parents=True, exist_ok=True)
    return base


def resolve(filename: str) -> Path:
    """Absolute path for ``filename``.

    A bare name (or relative path) lands inside :func:`log_dir`; an absolute
    path is used verbatim (lets a caller point a single sink anywhere).
    """
    p = Path(filename).expanduser()
    return p if p.is_absolute() else log_dir() / filename


def append_jsonl(filename: str, record: Dict[str, Any]) -> Optional[Path]:
    """Best-effort append of one JSON record (+newline) to ``<log_dir>/<filename>``.

    Thread-safe via the module lock so concurrent web_chat agent threads can't
    interleave a line.  ``ts`` is injected (ISO-8601, seconds) if absent.
    Returns the path written, or ``None`` on failure — never raises.
    """
    try:
        rec = dict(record)
        rec.setdefault("ts", datetime.now().isoformat(timespec="seconds"))
        line = json.dumps(rec, ensure_ascii=False) + "\n"
        with _LOCK:
            target = resolve(filename)
            target.parent.mkdir(parents=True, exist_ok=True)
            with open(target, "a", encoding="utf-8") as fh:
                fh.write(line)
        return target
    except Exception as exc:  # never break a real request over a debug write
        _FALLBACK.warning("append_jsonl(%s) failed: %r", filename, exc)
        return None


def get_file_logger(
    name: str,
    filename: str,
    level: int = logging.DEBUG,
    propagate: bool = False,
) -> logging.Logger:
    """A logger that tees human-readable lines into ``<log_dir>/<filename>``.

    Companion to :func:`append_jsonl` for places that want a normal
    ``log.info("...")`` line synced under ``./logs`` (e.g. ``tail -f
    logs/web_chat.log`` on the test box).  Reuses the upstream
    ``RedactingFormatter`` so secrets (API keys, tokens) are scrubbed before
    they reach a file that gets copied between machines.

    Idempotent: the file handler is attached at most once per ``name`` (tagged
    + cached), so repeated calls return the same logger without stacking
    handlers.  ``propagate`` defaults to ``False`` so this is a *dedicated*
    ``./logs`` sink and does not also spray into the operator's ``agent.log`` /
    stderr; pass ``True`` if you want both.
    """
    with _LOCK:
        cached = _LOGGERS.get(name)
        if cached is not None:
            return cached
        log = logging.getLogger(name)
        log.setLevel(level)
        log.propagate = propagate
        tag = f"_hermes_debug_file::{filename}"
        if not any(getattr(h, "_hermes_debug_tag", None) == tag for h in log.handlers):
            try:
                target = resolve(filename)
                target.parent.mkdir(parents=True, exist_ok=True)
                handler = logging.FileHandler(target, encoding="utf-8")
                handler.setLevel(level)
                try:
                    from agent.redact import RedactingFormatter

                    fmt: logging.Formatter = RedactingFormatter(
                        "%(asctime)s %(levelname)s %(name)s: %(message)s"
                    )
                except Exception:
                    fmt = logging.Formatter(
                        "%(asctime)s %(levelname)s %(name)s: %(message)s"
                    )
                handler.setFormatter(fmt)
                handler._hermes_debug_tag = tag  # type: ignore[attr-defined]
                log.addHandler(handler)
            except Exception as exc:
                _FALLBACK.warning(
                    "get_file_logger(%s, %s) handler attach failed: %r",
                    name, filename, exc,
                )
        _LOGGERS[name] = log
        return log
