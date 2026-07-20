"""Admin routes."""

from __future__ import annotations

from typing import Any, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from hermes_constants import get_hermes_home
from platform_api.deps import get_store, require_admin

router = APIRouter(prefix="/admin", tags=["admin"])


class UserStatusPatch(BaseModel):
    status: str


@router.get("/users")
def admin_users(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    email: Optional[str] = Query(None, max_length=256),
    admin_id: str = Depends(require_admin),
) -> dict[str, Any]:
    store = get_store()
    store.audit(admin_id, "admin.list_users")
    return store.list_users_admin(limit=limit, offset=offset, email=email)


@router.patch("/users/{user_id}")
def admin_patch_user(
    user_id: str,
    body: UserStatusPatch,
    admin_id: str = Depends(require_admin),
) -> dict[str, Any]:
    store = get_store()
    if body.status == "disabled":
        store.set_disabled(user_id, True)
    elif body.status == "active":
        store.set_disabled(user_id, False)
    else:
        raise HTTPException(status_code=400, detail="invalid status")
    store.audit(
        admin_id,
        "admin.set_user_status",
        target_type="user",
        target_id=user_id,
        status=body.status,
    )
    user = store.get_user(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="not found")
    return user


@router.get("/stats")
def admin_stats(admin_id: str = Depends(require_admin)) -> dict[str, Any]:
    store = get_store()
    store.audit(admin_id, "admin.stats")
    return store.admin_stats()


@router.get("/skills")
def admin_skills(admin_id: str = Depends(require_admin)) -> List[dict[str, str]]:
    store = get_store()
    store.audit(admin_id, "admin.list_global_skills")
    root = get_hermes_home() / "skills"
    out: list[dict[str, str]] = []
    if root.is_dir():
        for skill_md in root.rglob("SKILL.md"):
            out.append({"name": skill_md.parent.name, "path": str(skill_md.parent)})
    return sorted(out, key=lambda x: x["name"])


@router.get("/audit")
def admin_audit(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    admin_id: str = Depends(require_admin),
) -> dict[str, Any]:
    """Read-only audit trail (does not write a new audit row — avoids noise)."""
    del admin_id  # auth gate only
    store = get_store()
    return store.list_audit_logs(limit=limit, offset=offset)
