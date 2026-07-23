"""Health check — deep probes for DB / optional Redis / optional MinIO."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from platform_api.deps import get_store
from platform_api.services.health_checks import run_health_checks

router = APIRouter(tags=["health"])


@router.get("/healthz")
def healthz() -> JSONResponse:
    store = get_store()
    status_code, body = run_health_checks(store)
    return JSONResponse(status_code=status_code, content=body)
