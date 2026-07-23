"""Sandboxed web_search for web_chat — Brave + ddgs hybrid routing.

Overrides upstream ``web_search`` when ``gateway.web.tools`` is imported at
gateway startup (``override=True``). Per-user routing and Brave quota live
in :mod:`gateway.web.web_search_router`.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict

from gateway.web.sandbox import get_user_workspace
from gateway.web.web_search_limits import brave_search_api_key_configured
from gateway.web.web_search_router import search_for_user_json
from tools.registry import registry
from tools.web_tools import WEB_SEARCH_SCHEMA

logger = logging.getLogger("hermes.web.tools.sandboxed_web_search")

_TOOLSET = "web"


def _ddgs_importable() -> bool:
    try:
        import ddgs  # noqa: F401

        return True
    except ImportError:
        return False


def check_sandboxed_web_search_available() -> bool:
    """Expose web_search when Brave key or ddgs package is available."""
    return brave_search_api_key_configured() or _ddgs_importable()


def web_search_sandboxed(query: str, limit: int = 5, task_id: str = None) -> str:
    """Per-user web_search with Brave quota and ddgs fallback."""
    _ = task_id
    ws = get_user_workspace()
    if ws is None:
        return json.dumps({
            "success": False,
            "error": "internal sandbox not initialised",
        })

    user_id = ws.name
    return search_for_user_json(user_id, query, limit)


def _handle_web_search(args: Dict[str, Any], **kw: Any) -> str:
    return web_search_sandboxed(
        query=str(args.get("query", "")),
        limit=int(args.get("limit") or 5),
        task_id=kw.get("task_id"),
    )


registry.register(
    name="web_search",
    toolset=_TOOLSET,
    schema=WEB_SEARCH_SCHEMA,
    handler=_handle_web_search,
    check_fn=check_sandboxed_web_search_available,
    emoji="🔍",
    max_result_size_chars=100_000,
    override=True,
)
