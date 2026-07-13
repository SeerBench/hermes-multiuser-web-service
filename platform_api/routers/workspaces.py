"""Workspace routes."""

from __future__ import annotations

from typing import Any, List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select

from gateway.web.platform.models import Workspace
from platform_api.deps import get_current_user_id, get_store

router = APIRouter(prefix="/workspaces", tags=["workspaces"])


@router.get("")
def list_workspaces(user_id: str = Depends(get_current_user_id)) -> List[dict[str, Any]]:
    store = get_store()
    with store._session_factory() as db:
        rows = db.execute(
            select(Workspace).where(Workspace.owner_id == user_id)
        ).scalars()
        return [
            {
                "id": w.id,
                "tenant_id": w.tenant_id,
                "name": w.name,
                "created_at": w.created_at.timestamp(),
            }
            for w in rows
        ]


@router.get("/{workspace_id}")
def get_workspace(workspace_id: str, user_id: str = Depends(get_current_user_id)) -> dict[str, Any]:
    store = get_store()
    with store._session_factory() as db:
        ws = db.get(Workspace, workspace_id)
        if not ws or ws.owner_id != user_id:
            raise HTTPException(status_code=404, detail="not found")
        return {
            "id": ws.id,
            "tenant_id": ws.tenant_id,
            "name": ws.name,
            "created_at": ws.created_at.timestamp(),
        }
