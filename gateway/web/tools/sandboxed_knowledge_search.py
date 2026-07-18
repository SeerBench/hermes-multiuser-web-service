"""Sandboxed Knowledge Center search for the web_chat platform.

Queries ``knowledge_chunks`` for ready Knowledge Center bases owned by the
active user (via ``PLATFORM_DATABASE_URL``). File-page ``DocumentChunk``
ingest remains separate and is not used here.
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
    """Search the user's Knowledge Center (ready bases) for relevant passages."""
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
        from platform_api.services.knowledge_center import search_knowledge_chunks
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

    hits = search_knowledge_chunks(
        tenant_id=ws["tenant_id"],
        workspace_id=ws["id"],
        user_id=user_id,
        query=query,
        top_k=max(1, min(int(top_k or 5), 20)),
    )

    # Usage Center: knowledge search (representative knowledge tool hook)
    try:
        from gateway.web.usage_tracker import track

        track(
            user_id,
            "knowledge",
            tool_name="web_knowledge_search",
            workspace_id=ws["id"],
            tenant_id=ws.get("tenant_id"),
            metadata={"hit_count": len(hits), "top_k": max(1, min(int(top_k or 5), 20))},
        )
    except Exception:
        pass

    if not hits:
        return json.dumps({
            "success": True,
            "results": [],
            "query": query,
            "hint": (
                "No matching passages in ready Knowledge Center bases. "
                "Create a knowledge base from uploaded files in the Knowledge Center UI."
            ),
        })
    return json.dumps({"success": True, "results": hits, "query": query})


_WEB_KNOWLEDGE_SCHEMA: Dict[str, Any] = {
    "name": "web_knowledge_search",
    "description": (
        "Search the user's Knowledge Center (ready knowledge bases built from "
        "uploaded files) for passages relevant to a natural-language query. "
        "Use when the user refers to their personal knowledge bases."
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
