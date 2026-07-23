"""Per-user Brave web_search quota (operator env, Usage Center backed)."""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

logger = logging.getLogger("hermes.web.web_search_limits")

_DEFAULT_MAX_PER_USER = 20
_DEFAULT_WINDOW_SECONDS = 86400.0
_BACKEND_BRAVE = "brave-free"


def brave_search_api_key_configured() -> bool:
    return bool(os.environ.get("BRAVE_SEARCH_API_KEY", "").strip())


def get_brave_max_per_user() -> int:
    raw = os.environ.get("WEB_SEARCH_BRAVE_MAX_PER_USER", str(_DEFAULT_MAX_PER_USER))
    try:
        return max(0, int(raw))
    except (TypeError, ValueError):
        return _DEFAULT_MAX_PER_USER


def get_brave_window_seconds() -> float:
    raw = os.environ.get(
        "WEB_SEARCH_BRAVE_WINDOW_SECONDS", str(_DEFAULT_WINDOW_SECONDS)
    )
    try:
        return max(60.0, float(raw))
    except (TypeError, ValueError):
        return _DEFAULT_WINDOW_SECONDS


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def count_brave_uses(user_id: str, *, window_seconds: float | None = None) -> int:
    """Count successful Brave searches for ``user_id`` in the rolling window."""
    if not user_id:
        return 0
    window = window_seconds if window_seconds is not None else get_brave_window_seconds()
    cutoff = _utcnow() - timedelta(seconds=window)
    try:
        from sqlalchemy import select

        from gateway.web.platform.models import UsageRecord
        from platform_api.deps import get_store

        store = get_store()
        with store._session_factory() as db:
            rows = db.execute(
                select(UsageRecord).where(
                    UsageRecord.user_id == user_id,
                    UsageRecord.type == "tool",
                    UsageRecord.tool_name == "web_search",
                    UsageRecord.created_at >= cutoff,
                )
            ).scalars().all()
        count = 0
        for row in rows:
            meta = row.metadata_json if isinstance(row.metadata_json, dict) else {}
            if meta.get("backend") == _BACKEND_BRAVE:
                count += 1
        return count
    except Exception:
        logger.debug("count_brave_uses failed user=%s", user_id, exc_info=True)
        # Fail closed: treat as quota exhausted so we fall back to ddgs.
        return get_brave_max_per_user()


def get_brave_remaining(user_id: str) -> int:
    """Remaining Brave searches for ``user_id`` in the configured window."""
    limit = get_brave_max_per_user()
    if limit <= 0 or not brave_search_api_key_configured():
        return 0
    used = count_brave_uses(user_id)
    return max(0, limit - used)


def record_brave_use(
    user_id: str,
    *,
    query: str,
    urls: list[str],
) -> None:
    """Persist one Brave search to Usage Center (best-effort)."""
    if not user_id:
        return
    try:
        from gateway.web.usage_tracker import track

        track(
            user_id,
            "tool",
            tool_name="web_search",
            metadata={
                "backend": _BACKEND_BRAVE,
                "query": (query or "")[:256],
                "url_count": len(urls),
                "urls": urls[:10],
            },
        )
    except Exception:
        logger.debug("record_brave_use failed user=%s", user_id, exc_info=True)


def format_search_status_message(meta: Optional[dict[str, Any]]) -> str:
    """User-facing SSE status line after a web_search completes."""
    meta = meta or {}
    backend = meta.get("backend")
    if backend == _BACKEND_BRAVE:
        remaining = meta.get("brave_remaining")
        if remaining is not None:
            return f"使用 Brave 搜索，Brave 用量还剩 {remaining} 次"
        return "使用 Brave 搜索"
    if backend == "ddgs":
        reason = meta.get("fallback_reason")
        if reason == "brave_quota_exhausted":
            return "使用 DuckDuckGo 搜索（Brave 额度已用完）"
        if reason == "no_brave_key":
            return "使用 DuckDuckGo 搜索"
        return "使用 DuckDuckGo 搜索"
    return "联网搜索完成"


def parse_search_meta_from_result(result: Any) -> Optional[dict[str, Any]]:
    """Extract ``_meta`` from a web_search tool result (str or dict)."""
    payload: Any = result
    if isinstance(result, str):
        try:
            import json

            payload = json.loads(result)
        except (TypeError, ValueError, json.JSONDecodeError):
            return None
    if not isinstance(payload, dict):
        return None
    meta = payload.get("_meta")
    return meta if isinstance(meta, dict) else None
