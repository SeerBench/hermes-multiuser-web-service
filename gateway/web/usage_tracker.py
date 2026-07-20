"""Unified Usage Tracker entry — Gateway boundary only (Strategy 2).

Call sites: web_chat turn done, sandboxed skill/knowledge tools.
Never import this from ``run_agent.py`` / MemoryManager.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger("hermes.web.usage_tracker")


def track(
    user_id: str,
    type: str,
    *,
    model: Optional[str] = None,
    skill_name: Optional[str] = None,
    knowledge_id: Optional[str] = None,
    tool_name: Optional[str] = None,
    input_tokens: int = 0,
    output_tokens: int = 0,
    total_tokens: Optional[int] = None,
    cost: Optional[float] = None,
    metadata: Optional[dict[str, Any]] = None,
    session_id: Optional[str] = None,
    workspace_id: Optional[str] = None,
    tenant_id: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Best-effort write to Usage Center. Failures are logged, never raised."""
    if not user_id:
        return None
    try:
        from platform_api.services import usage as usage_svc

        return usage_svc.create_record(
            user_id=user_id,
            type=type,
            workspace_id=workspace_id,
            tenant_id=tenant_id,
            model=model,
            skill_name=skill_name,
            knowledge_id=knowledge_id,
            tool_name=tool_name,
            session_id=session_id,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=total_tokens,
            cost=cost,
            metadata=metadata,
        )
    except Exception:
        logger.debug("usage track failed user=%s type=%s", user_id, type, exc_info=True)
        return None


def track_chat_turn(
    *,
    user_id: str,
    session_id: Optional[str],
    model: Optional[str],
    usage: Optional[dict[str, Any]],
    workspace_id: Optional[str] = None,
    tenant_id: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Record a successful chat turn (tokens + model on one ``chat`` row)."""
    u = usage or {}
    return track(
        user_id,
        "chat",
        model=model,
        session_id=session_id,
        input_tokens=int(u.get("input_tokens") or 0),
        output_tokens=int(u.get("output_tokens") or 0),
        total_tokens=int(u.get("total_tokens") or 0) or None,
        workspace_id=workspace_id,
        tenant_id=tenant_id,
        metadata={"source": "web_chat"},
    )
