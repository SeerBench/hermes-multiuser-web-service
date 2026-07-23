"""Usage Center API — current user's platform activity ledger."""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from platform_api.deps import get_current_user_id
from platform_api.services import usage as usage_svc

router = APIRouter(prefix="/usage", tags=["usage"])


@router.get("/summary")
def usage_summary(user_id: str = Depends(get_current_user_id)) -> dict[str, Any]:
    return usage_svc.get_summary(user_id=user_id)


@router.get("/trend")
def usage_trend(
    days: int = Query(default=7, ge=1, le=30),
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    return usage_svc.get_trend(user_id=user_id, days=days)


@router.get("/by-model")
def usage_by_model(
    days: int = Query(default=30, ge=1, le=90),
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    return usage_svc.get_by_model(user_id=user_id, days=days)


@router.get("/by-skill")
def usage_by_skill(
    days: int = Query(default=30, ge=1, le=90),
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    return usage_svc.get_by_skill(user_id=user_id, days=days)


@router.get("/logs")
def usage_logs(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    type: Optional[str] = Query(default=None),
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    return usage_svc.list_logs(
        user_id=user_id, limit=limit, offset=offset, type=type
    )


@router.post("/record")
def usage_record_forbidden(
    user_id: str = Depends(get_current_user_id),
) -> dict[str, str]:
    """SPA must not write arbitrary usage rows — Tracker is server-side only."""
    _ = user_id
    raise HTTPException(status_code=403, detail="usage records are server-side only")
