"""Memory read/write facade over per-user MEMORY.md / USER.md."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from gateway.web.sandbox import enter_user_context
from platform_api.deps import get_current_user_id, get_store

router = APIRouter(prefix="/workspaces", tags=["memory"])

_MEMORY_FILE = "memories/MEMORY.md"
_PROFILE_FILE = "memories/USER.md"


class MemoryPatch(BaseModel):
    long_term: Optional[str] = None
    profile: Optional[str] = None


def _read_text(path: Path) -> str:
    if not path.is_file():
        return ""
    return path.read_text(encoding="utf-8")


@router.get("/{workspace_id}/memory")
def get_memory(workspace_id: str, user_id: str = Depends(get_current_user_id)) -> dict[str, Any]:
    _assert_workspace(workspace_id, user_id)
    with enter_user_context(user_id):
        from gateway.web.sandbox import get_user_workspace

        ws = get_user_workspace()
        return {
            "long_term": _read_text(ws / _MEMORY_FILE),
            "profile": _read_text(ws / _PROFILE_FILE),
        }


@router.patch("/{workspace_id}/memory")
def patch_memory(
    workspace_id: str,
    body: MemoryPatch,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, str]:
    _assert_workspace(workspace_id, user_id)
    with enter_user_context(user_id):
        from gateway.web.sandbox import get_user_workspace

        root = get_user_workspace()
        (root / "memories").mkdir(parents=True, exist_ok=True)
        if body.long_term is not None:
            (root / _MEMORY_FILE).write_text(body.long_term, encoding="utf-8")
        if body.profile is not None:
            (root / _PROFILE_FILE).write_text(body.profile, encoding="utf-8")
    return {"status": "ok"}


def _assert_workspace(workspace_id: str, user_id: str) -> None:
    from sqlalchemy import select

    from gateway.web.platform.models import Workspace

    store = get_store()
    with store._session_factory() as db:
        ws = db.get(Workspace, workspace_id)
        if not ws or ws.owner_id != user_id:
            raise HTTPException(status_code=404, detail="not found")
