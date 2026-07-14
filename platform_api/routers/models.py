"""Workspace model list + user preferences."""

from __future__ import annotations

import os
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from gateway.web.platform.models import Workspace
from gateway.web.platform.store import PlatformStore
from platform_api.deps import get_current_user_id, get_store, get_vault

router = APIRouter(prefix="/workspaces", tags=["models"])


class PreferencesPatch(BaseModel):
    preferred_model: Optional[str] = Field(default=None, max_length=256)


@router.get("/{workspace_id}/models")
def list_models(
    workspace_id: str,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    """Proxy new-api /v1/models using the caller's upstream key."""
    ws = _get_workspace(workspace_id, user_id)
    store = get_store()
    if not isinstance(store, PlatformStore):
        raise HTTPException(status_code=503, detail="platform store required")

    enc = store.get_user_upstream_key_enc(user_id)
    if not enc:
        raise HTTPException(status_code=403, detail="upstream key not bound")

    api_key = get_vault().decrypt(enc)
    base = os.environ.get("NEW_API_BASE_URL", "").strip().rstrip("/")
    if not base:
        raise HTTPException(status_code=503, detail="NEW_API_BASE_URL not configured")

    try:
        with httpx.Client(timeout=15.0) as client:
            resp = client.get(
                f"{base}/v1/models",
                headers={"Authorization": f"Bearer {api_key}"},
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=resp.text[:500])

    payload = resp.json()
    models = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(models, list):
        models = []

    out = []
    for m in models:
        if not isinstance(m, dict):
            continue
        mid = m.get("id")
        if not mid:
            continue
        out.append({"id": str(mid), "owned_by": m.get("owned_by")})

    prefs = _read_preferences(ws)
    return {
        "models": sorted(out, key=lambda x: x["id"]),
        "preferred_model": prefs.get("preferred_model"),
        "default_model": _gateway_default_model(),
    }


@router.get("/{workspace_id}/preferences")
def get_preferences(
    workspace_id: str,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    ws = _get_workspace(workspace_id, user_id)
    prefs = _read_preferences(ws)
    return {
        "preferred_model": prefs.get("preferred_model"),
        "default_model": _gateway_default_model(),
    }


@router.patch("/{workspace_id}/preferences")
def patch_preferences(
    workspace_id: str,
    body: PreferencesPatch,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    ws = _get_workspace(workspace_id, user_id)
    store = get_store()
    from gateway.web.platform.database import session_scope

    with session_scope(store._engine) as db:
        row = db.get(Workspace, ws.id)
        if row is None:
            raise HTTPException(status_code=404, detail="not found")
        prefs = dict(row.settings_json or {})
        if body.preferred_model is not None:
            prefs["preferred_model"] = body.preferred_model.strip() or None
        row.settings_json = prefs
        db.add(row)

    return {
        "preferred_model": prefs.get("preferred_model"),
        "default_model": _gateway_default_model(),
    }


def resolve_workspace_model(workspace_id: str, user_id: str) -> Optional[str]:
    """Return persisted preferred_model for a workspace, if any."""
    store = get_store()
    with store._session_factory() as db:
        ws = db.get(Workspace, workspace_id)
        if not ws or ws.owner_id != user_id:
            return None
        prefs = ws.settings_json or {}
        model = prefs.get("preferred_model")
        return str(model).strip() if model else None


def _read_preferences(ws: Workspace) -> dict[str, Any]:
    return dict(ws.settings_json or {})


def _gateway_default_model() -> str:
    try:
        from gateway.run import _resolve_gateway_model

        return (_resolve_gateway_model() or "").strip()
    except Exception:
        return ""


def _get_workspace(workspace_id: str, user_id: str) -> Workspace:
    store = get_store()
    with store._session_factory() as db:
        ws = db.get(Workspace, workspace_id)
        if not ws or ws.owner_id != user_id:
            raise HTTPException(status_code=404, detail="not found")
        return ws
