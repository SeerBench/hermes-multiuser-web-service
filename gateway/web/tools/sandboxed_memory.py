"""Web-chat memory tool — proposals go to Memory Center as pending.

Unlike upstream ``memory`` (which writes MEMORY.md / USER.md immediately),
``web_memory`` only creates ``pending`` rows in the platform DB. Users must
approve in the Memory Center before content is projected into the Hermes
prompt files. This enforces: Agent cannot silently permanently save.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, Optional

from gateway.web.sandbox import get_user_workspace
from tools.registry import registry

logger = logging.getLogger("hermes.web.tools.sandboxed_memory")

_TOOLSET = "web_memory"


def _active_user_id() -> Optional[str]:
    ws = get_user_workspace()
    if ws is None:
        return None
    return ws.name


def _platform_store():
    from gateway.web.platform.store import PlatformStore
    from gateway.web.user_store_factory import create_user_store

    store = create_user_store()
    if not isinstance(store, PlatformStore):
        return None
    return store


def web_memory(
    action: str,
    target: str = "memory",
    content: str = None,
    old_text: str = None,
    task_id: str = None,
) -> str:
    """Propose or adjust pending memories for the active web user."""
    _ = task_id
    user_id = _active_user_id()
    if not user_id:
        return json.dumps({
            "success": False,
            "error": "internal sandbox not initialised",
        })

    if target not in {"memory", "user"}:
        return json.dumps({
            "success": False,
            "error": "Invalid target. Use 'memory' or 'user'.",
        })

    store = _platform_store()
    if store is None:
        return json.dumps({
            "success": False,
            "error": "Memory Center requires PLATFORM_DATABASE_URL",
        })

    from gateway.web.platform.database import session_scope
    from gateway.web.platform.models import MemoryItem
    from platform_api.services import memory_center as mc
    from sqlalchemy import select

    ws = store.get_default_workspace(user_id) or store.ensure_default_workspace(user_id)
    if not ws:
        return json.dumps({"success": False, "error": "no workspace for user"})

    category = "profile" if target == "user" else "knowledge"

    try:
        with session_scope(store._engine) as db:
            from gateway.web.platform.models import Workspace

            workspace = db.get(Workspace, ws["id"])
            if not workspace:
                return json.dumps({"success": False, "error": "workspace missing"})

            if action == "add":
                if not content or not str(content).strip():
                    return json.dumps({
                        "success": False,
                        "error": "Content is required for 'add'.",
                    })
                row = mc.create_pending_from_agent(
                    db,
                    workspace=workspace,
                    user_id=user_id,
                    content=str(content).strip(),
                    category=category,
                    confidence=0.85,
                )
                return json.dumps({
                    "success": True,
                    "status": "pending",
                    "id": row.id,
                    "message": (
                        "Suggested memory queued for user review in Memory Center. "
                        "It will NOT appear in long-term memory until approved."
                    ),
                    "content": row.content,
                    "category": row.category,
                }, ensure_ascii=False)

            if action in {"replace", "remove"}:
                if not old_text:
                    return json.dumps({
                        "success": False,
                        "error": "old_text is required for replace/remove.",
                    })
                needle = str(old_text).strip()
                pending = list(
                    db.execute(
                        select(MemoryItem).where(
                            MemoryItem.workspace_id == workspace.id,
                            MemoryItem.status == "pending",
                        )
                    ).scalars().all()
                )
                match = next((r for r in pending if needle in r.content), None)
                if match is None:
                    return json.dumps({
                        "success": False,
                        "error": (
                            "No matching pending suggestion. Active memories can "
                            "only be changed by the user in Memory Center."
                        ),
                    })
                if action == "remove":
                    match.status = "archived"
                    match.updated_at = mc._utcnow()
                    db.add(match)
                    return json.dumps({
                        "success": True,
                        "status": "archived",
                        "id": match.id,
                        "message": "Pending suggestion discarded.",
                    })
                if not content or not str(content).strip():
                    return json.dumps({
                        "success": False,
                        "error": "content is required for replace.",
                    })
                mc.update_item(db, match, content=str(content).strip())
                return json.dumps({
                    "success": True,
                    "status": "pending",
                    "id": match.id,
                    "message": "Pending suggestion updated; still awaiting approval.",
                    "content": match.content,
                }, ensure_ascii=False)

            return json.dumps({
                "success": False,
                "error": "Unknown action. Use: add, replace, remove",
            })
    except Exception as exc:
        logger.exception("web_memory failed")
        return json.dumps({"success": False, "error": str(exc)})


_WEB_MEMORY_SCHEMA: Dict[str, Any] = {
    "name": "web_memory",
    "description": (
        "Propose durable facts for the user's Memory Center. Suggestions are "
        "queued as PENDING and require explicit user approval before they enter "
        "long-term memory / the system prompt. Do NOT assume a save is permanent.\n\n"
        "WHEN TO PROPOSE: user corrections, stable preferences, role/identity, "
        "project conventions that will matter later.\n\n"
        "TARGETS: 'user' (profile) or 'memory' (notes/knowledge).\n"
        "ACTIONS: add (new pending suggestion), replace/remove (only pending "
        "items matched by old_text). Active memories are user-controlled."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["add", "replace", "remove"],
                "description": "The action to perform.",
            },
            "target": {
                "type": "string",
                "enum": ["memory", "user"],
                "description": "'user' for profile, 'memory' for notes.",
            },
            "content": {
                "type": "string",
                "description": "Entry content for add/replace.",
            },
            "old_text": {
                "type": "string",
                "description": "Substring identifying a pending entry.",
            },
        },
        "required": ["action", "target"],
    },
}


def _handle_web_memory(args: Dict[str, Any], **kw: Any) -> str:
    return web_memory(
        action=str(args.get("action", "")),
        target=str(args.get("target") or "memory"),
        content=args.get("content"),
        old_text=args.get("old_text"),
        task_id=kw.get("task_id"),
    )


registry.register(
    name="web_memory",
    toolset=_TOOLSET,
    schema=_WEB_MEMORY_SCHEMA,
    handler=_handle_web_memory,
    check_fn=lambda: bool(os.environ.get("PLATFORM_DATABASE_URL")),
)
