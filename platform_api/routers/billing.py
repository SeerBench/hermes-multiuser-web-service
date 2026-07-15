"""Proxy new-api token usage + consumption logs for the caller's bound key."""

from __future__ import annotations

import os
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException

from gateway.web.platform.store import PlatformStore
from platform_api.deps import get_current_user_id, get_store, get_vault

router = APIRouter(prefix="/billing", tags=["billing"])


def _new_api_base() -> str:
    base = (os.environ.get("NEW_API_BASE_URL") or "").strip().rstrip("/")
    if not base:
        raise HTTPException(status_code=503, detail="NEW_API_BASE_URL not configured")
    return base


def _decrypt_upstream_key(user_id: str) -> str:
    store = get_store()
    if not isinstance(store, PlatformStore):
        raise HTTPException(status_code=503, detail="platform store required")
    enc = store.get_user_upstream_key_enc(user_id)
    if not enc:
        raise HTTPException(status_code=403, detail="upstream key not bound")
    try:
        return get_vault().decrypt(enc)
    except Exception as exc:  # noqa: BLE001 — vault failures surface as 500
        raise HTTPException(status_code=500, detail="key storage error") from exc


@router.get("/usage")
def get_usage(user_id: str = Depends(get_current_user_id)) -> dict[str, Any]:
    """Return quota for the user's bound new-api token (no raw key)."""
    api_key = _decrypt_upstream_key(user_id)
    base = _new_api_base()
    try:
        with httpx.Client(timeout=15.0) as client:
            resp = client.get(
                f"{base}/api/usage/token",
                headers={"Authorization": f"Bearer {api_key}"},
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    if resp.status_code == 401:
        raise HTTPException(status_code=401, detail="upstream key rejected")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=resp.text[:500])

    payload = resp.json()
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail="unexpected upstream payload")

    return {
        "name": data.get("name"),
        "total_granted": data.get("total_granted"),
        "total_used": data.get("total_used"),
        "total_available": data.get("total_available"),
        "unlimited_quota": bool(data.get("unlimited_quota")),
        "expires_at": data.get("expires_at") or 0,
        "model_limits_enabled": bool(data.get("model_limits_enabled")),
    }


@router.get("/logs")
def get_logs(
    user_id: str = Depends(get_current_user_id),
    limit: int = 50,
) -> dict[str, Any]:
    """Recent consumption logs for the bound token (server-side key, never leaked)."""
    api_key = _decrypt_upstream_key(user_id)
    base = _new_api_base()
    limit = max(1, min(limit, 100))
    try:
        with httpx.Client(timeout=15.0) as client:
            resp = client.get(
                f"{base}/api/log/token",
                params={"key": api_key},
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=resp.text[:500])

    payload = resp.json()
    if isinstance(payload, dict) and payload.get("success") is False:
        raise HTTPException(
            status_code=502,
            detail=str(payload.get("message") or "upstream log query failed"),
        )

    raw = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(raw, list):
        raw = []

    items: list[dict[str, Any]] = []
    for row in raw[:limit]:
        if not isinstance(row, dict):
            continue
        items.append(
            {
                "id": row.get("id"),
                "type": row.get("type"),
                "content": row.get("content"),
                "model_name": row.get("model_name"),
                "quota": row.get("quota"),
                "prompt_tokens": row.get("prompt_tokens"),
                "completion_tokens": row.get("completion_tokens"),
                "created_at": row.get("created_at"),
            }
        )

    return {"items": items}
