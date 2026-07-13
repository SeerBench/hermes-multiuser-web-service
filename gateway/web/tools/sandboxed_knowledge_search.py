"""Sandboxed knowledge-base search for the web_chat platform.

Queries document chunks scoped to the active user's workspace via the
platform control-plane database (``PLATFORM_DATABASE_URL``).
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict

from gateway.web.sandbox import get_user_workspace
from tools.registry import registry

logger = logging.getLogger("hermes.web.tools.sandboxed_knowledge_search")

_TOOLSET = "web_knowledge"


def _active_user_id() -> str | None:
    ws = get_user_workspace()
    if ws is None:
        return None
    return ws.name


def web_knowledge_search(query: str, top_k: int = 5, task_id: str = None) -> str:
    """Search the user's uploaded knowledge base for relevant passages."""
    _ = task_id
    user_id = _active_user_id()
    if not user_id:
        return json.dumps({
            "success": False,
            "error": "internal sandbox not initialised",
        })

    try:
        from gateway.web.platform.store import PlatformStore
        from gateway.web.user_store_factory import create_user_store
        from platform_api.services.knowledge import search_knowledge
    except ImportError as exc:
        return json.dumps({
            "success": False,
            "error": f"knowledge search unavailable: {exc}",
        })

    store = create_user_store()
    if not isinstance(store, PlatformStore):
        return json.dumps({
            "success": False,
            "error": "knowledge base requires PLATFORM_DATABASE_URL",
        })

    ws = store.get_default_workspace(user_id)
    if not ws:
        return json.dumps({"success": False, "error": "no workspace for user"})

    hits = search_knowledge(
        tenant_id=ws["tenant_id"],
        workspace_id=ws["id"],
        query=query,
        top_k=max(1, min(int(top_k or 5), 20)),
    )
    return json.dumps({"success": True, "results": hits, "query": query})


_WEB_KNOWLEDGE_SCHEMA: Dict[str, Any] = {
    "name": "web_knowledge_search",
    "description": (
        "Search the user's uploaded documents (PDF, DOCX, etc.) for passages "
        "relevant to a natural-language query. Use when the user refers to "
        "uploaded files or a personal knowledge base."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Natural-language search query.",
            },
            "top_k": {
                "type": "integer",
                "description": "Maximum number of chunks to return (default 5).",
                "default": 5,
            },
        },
        "required": ["query"],
    },
}


def _handle_web_knowledge_search(args: Dict[str, Any], **kw: Any) -> str:
    return web_knowledge_search(
        query=str(args.get("query", "")),
        top_k=int(args.get("top_k") or 5),
        task_id=kw.get("task_id"),
    )


registry.register(
    name="web_knowledge_search",
    toolset=_TOOLSET,
    schema=_WEB_KNOWLEDGE_SCHEMA,
    handler=_handle_web_knowledge_search,
    check_fn=lambda: bool(__import__("os").environ.get("PLATFORM_DATABASE_URL")),
)
