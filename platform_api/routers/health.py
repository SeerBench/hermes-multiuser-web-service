"""Health check."""

from __future__ import annotations

from fastapi import APIRouter

from platform_api.deps import get_store

router = APIRouter(tags=["health"])


@router.get("/healthz")
def healthz() -> dict:
    store = get_store()
    _ = store  # ensure store initializes
    return {"status": "ok", "service": "platform-api"}
