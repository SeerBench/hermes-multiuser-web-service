"""Memory Center API + legacy whole-file MEMORY.md / USER.md facade."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from gateway.web.platform.database import session_scope
from gateway.web.platform.models import MemoryItem
from gateway.web.sandbox import enter_user_context
from platform_api.deps import get_current_user_id, get_store
from platform_api.services import memory_center as mc

router = APIRouter(prefix="/workspaces", tags=["memory"])

_MEMORY_FILE = "memories/MEMORY.md"
_PROFILE_FILE = "memories/USER.md"


# ── Legacy whole-file API (deprecated; kept for compatibility) ─────────────


class MemoryPatch(BaseModel):
    long_term: Optional[str] = None
    profile: Optional[str] = None


def _read_text(path: Path) -> str:
    if not path.is_file():
        return ""
    return path.read_text(encoding="utf-8")


def _assert_workspace(workspace_id: str, user_id: str) -> None:
    store = get_store()
    with store._session_factory() as db:
        try:
            mc.assert_workspace(db, workspace_id, user_id)
        except LookupError:
            raise HTTPException(status_code=404, detail="not found") from None


@router.get("/{workspace_id}/memory")
def get_memory(workspace_id: str, user_id: str = Depends(get_current_user_id)) -> dict[str, Any]:
    """Deprecated: prefer GET .../memory/items. Returns projected md files."""
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
    """Deprecated: whole-file overwrite. Prefer structured items API."""
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


# ── Memory Center structured API ───────────────────────────────────────────


class MemoryItemCreate(BaseModel):
    category: str = "knowledge"
    content: str
    source: str = "manual"
    status: str = "active"
    confidence: float = 1.0
    importance: int = 50
    source_ref: Optional[str] = None
    raw_excerpt: Optional[str] = None
    ai_summary: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None


class MemoryItemUpdate(BaseModel):
    content: Optional[str] = None
    category: Optional[str] = None
    confidence: Optional[float] = None
    importance: Optional[int] = None
    source_ref: Optional[str] = None
    raw_excerpt: Optional[str] = None
    ai_summary: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None
    status: Optional[str] = None


@router.get("/{workspace_id}/memory/stats")
def memory_stats(
    workspace_id: str,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    store = get_store()
    with store._session_factory() as db:
        try:
            mc.assert_workspace(db, workspace_id, user_id)
        except LookupError:
            raise HTTPException(status_code=404, detail="not found") from None
        return mc.get_stats(db, workspace_id=workspace_id)


@router.get("/{workspace_id}/memory/items")
def list_memory_items(
    workspace_id: str,
    q: Optional[str] = Query(default=None),
    category: Optional[str] = Query(default=None),
    status: Optional[str] = Query(default=None),
    sort: str = Query(default="updated_at"),
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    store = get_store()
    with store._session_factory() as db:
        try:
            mc.assert_workspace(db, workspace_id, user_id)
        except LookupError:
            raise HTTPException(status_code=404, detail="not found") from None
        rows = mc.list_items(
            db,
            workspace_id=workspace_id,
            q=q,
            category=category,
            status=status,
            sort=sort,
        )
        return {"items": [mc.item_to_dict(r) for r in rows]}


@router.post("/{workspace_id}/memory/items")
def create_memory_item(
    workspace_id: str,
    body: MemoryItemCreate,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    store = get_store()
    with session_scope(store._engine) as db:
        try:
            workspace = mc.assert_workspace(db, workspace_id, user_id)
            row = mc.create_item(
                db,
                workspace=workspace,
                user_id=user_id,
                category=body.category,
                content=body.content,
                source=body.source,
                status=body.status,
                confidence=body.confidence,
                importance=body.importance,
                source_ref=body.source_ref,
                raw_excerpt=body.raw_excerpt,
                ai_summary=body.ai_summary,
                metadata=body.metadata,
            )
            if row.status == "active":
                mc.project_active_memories(
                    db, workspace_id=workspace_id, user_id=user_id
                )
            return mc.item_to_dict(row)
        except LookupError:
            raise HTTPException(status_code=404, detail="not found") from None
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None


@router.put("/{workspace_id}/memory/items/{item_id}")
def update_memory_item(
    workspace_id: str,
    item_id: str,
    body: MemoryItemUpdate,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    store = get_store()
    with session_scope(store._engine) as db:
        try:
            mc.assert_workspace(db, workspace_id, user_id)
        except LookupError:
            raise HTTPException(status_code=404, detail="not found") from None
        row = db.get(MemoryItem, item_id)
        if not row or row.workspace_id != workspace_id:
            raise HTTPException(status_code=404, detail="not found")
        try:
            mc.update_item(
                db,
                row,
                content=body.content,
                category=body.category,
                confidence=body.confidence,
                importance=body.importance,
                source_ref=body.source_ref,
                raw_excerpt=body.raw_excerpt,
                ai_summary=body.ai_summary,
                metadata=body.metadata,
                status=body.status,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        mc.project_active_memories(db, workspace_id=workspace_id, user_id=user_id)
        return mc.item_to_dict(row)


@router.delete("/{workspace_id}/memory/items/{item_id}")
def delete_memory_item(
    workspace_id: str,
    item_id: str,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, str]:
    store = get_store()
    with session_scope(store._engine) as db:
        try:
            mc.assert_workspace(db, workspace_id, user_id)
        except LookupError:
            raise HTTPException(status_code=404, detail="not found") from None
        row = db.get(MemoryItem, item_id)
        if not row or row.workspace_id != workspace_id:
            raise HTTPException(status_code=404, detail="not found")
        db.delete(row)
        db.flush()
        mc.project_active_memories(db, workspace_id=workspace_id, user_id=user_id)
    return {"status": "deleted"}


@router.post("/{workspace_id}/memory/items/{item_id}/approve")
def approve_memory_item(
    workspace_id: str,
    item_id: str,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    store = get_store()
    with session_scope(store._engine) as db:
        try:
            mc.assert_workspace(db, workspace_id, user_id)
        except LookupError:
            raise HTTPException(status_code=404, detail="not found") from None
        row = db.get(MemoryItem, item_id)
        if not row or row.workspace_id != workspace_id:
            raise HTTPException(status_code=404, detail="not found")
        row.status = "active"
        row.updated_at = mc._utcnow()
        db.add(row)
        db.flush()
        mc.project_active_memories(db, workspace_id=workspace_id, user_id=user_id)
        return mc.item_to_dict(row)


@router.post("/{workspace_id}/memory/items/{item_id}/reject")
def reject_memory_item(
    workspace_id: str,
    item_id: str,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    store = get_store()
    with session_scope(store._engine) as db:
        try:
            mc.assert_workspace(db, workspace_id, user_id)
        except LookupError:
            raise HTTPException(status_code=404, detail="not found") from None
        row = db.get(MemoryItem, item_id)
        if not row or row.workspace_id != workspace_id:
            raise HTTPException(status_code=404, detail="not found")
        row.status = "archived"
        row.updated_at = mc._utcnow()
        db.add(row)
        db.flush()
        return mc.item_to_dict(row)


@router.post("/{workspace_id}/memory/migrate-from-files")
def migrate_memory_from_files(
    workspace_id: str,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, int]:
    store = get_store()
    with session_scope(store._engine) as db:
        try:
            workspace = mc.assert_workspace(db, workspace_id, user_id)
            return mc.migrate_from_files(db, workspace=workspace, user_id=user_id)
        except LookupError:
            raise HTTPException(status_code=404, detail="not found") from None
