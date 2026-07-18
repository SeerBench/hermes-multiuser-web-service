"""Conversation → pending memory extraction (Phase 2 stub).

MVP: disabled by default. When ``PLATFORM_MEMORY_EXTRACTOR=1``, a hook may
call :func:`maybe_enqueue_memory_extraction` after a chat turn. The real LLM
extractor is not implemented yet — this module only defines the contract so
gateway code can wire a no-op safely.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

logger = logging.getLogger("hermes.platform.memory_extractor")


def extractor_enabled() -> bool:
    return os.environ.get("PLATFORM_MEMORY_EXTRACTOR", "").strip() in {
        "1",
        "true",
        "yes",
        "on",
    }


def maybe_enqueue_memory_extraction(
    *,
    user_id: str,
    workspace_id: str,
    session_id: str,
    messages: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    """Enqueue post-turn memory extraction.

    Returns a status dict. When the feature flag is off, returns
    ``{"enqueued": False, "reason": "disabled"}`` without side effects.
    When on, MVP still no-ops (LLM path not shipped) so chat never auto-writes
    permanent memory.
    """
    _ = messages
    if not extractor_enabled():
        return {"enqueued": False, "reason": "disabled"}

    logger.info(
        "memory extraction stub: user=%s workspace=%s session=%s "
        "(no permanent writes; pending-only path not yet implemented)",
        user_id,
        workspace_id,
        session_id,
    )
    return {
        "enqueued": False,
        "reason": "stub",
        "user_id": user_id,
        "workspace_id": workspace_id,
        "session_id": session_id,
    }
