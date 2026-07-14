"""Skill entitlements + catalog install into workspace."""

from __future__ import annotations

from pathlib import Path
from typing import Any, List, Optional

import yaml
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from gateway.web.platform.models import SkillEntitlement, Workspace
from gateway.web.sandbox import enter_user_context
from hermes_constants import get_hermes_home
from platform_api.deps import get_current_user_id, get_store

router = APIRouter(prefix="/workspaces", tags=["skills"])


class SkillPatch(BaseModel):
    enabled: Optional[bool] = None
    config: Optional[dict[str, Any]] = None


class InstallFromCatalogBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    overwrite: bool = False


class SkillCreateBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    skill_md: str = Field(..., min_length=1)
    category: str = Field(default="productivity", min_length=1, max_length=64)


class SkillWriteBody(BaseModel):
    skill_md: str = Field(..., min_length=1)


@router.get("/{workspace_id}/skills")
def list_skills(workspace_id: str, user_id: str = Depends(get_current_user_id)) -> List[dict[str, Any]]:
    ws = _get_workspace(workspace_id, user_id)
    entitlements = _load_entitlements(workspace_id)
    global_skills = _scan_skills(get_hermes_home() / "skills", source="global")
    user_skills: list[dict[str, Any]] = []
    with enter_user_context(user_id):
        from gateway.web.sandbox import get_user_workspace

        user_skills = _scan_skills(get_user_workspace() / "skills", source="user")

    merged: dict[str, dict[str, Any]] = {}
    for s in global_skills + user_skills:
        merged[s["name"]] = s
    for name, ent in entitlements.items():
        if name in merged:
            merged[name]["enabled"] = ent["enabled"]
            merged[name]["config"] = ent.get("config") or {}
        else:
            merged[name] = {
                "name": name,
                "source": "entitlement",
                "enabled": ent["enabled"],
                "config": ent.get("config") or {},
            }
    for s in merged.values():
        s.setdefault("enabled", True)
    return sorted(merged.values(), key=lambda x: x["name"])


@router.post("/{workspace_id}/skills/install-from-catalog")
def install_from_catalog(
    workspace_id: str,
    body: InstallFromCatalogBody,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    """Copy a global catalog skill into the caller's private workspace."""
    _get_workspace(workspace_id, user_id)
    from gateway.web.tools.sandboxed_skill_manage import install_skill_from_catalog

    with enter_user_context(user_id):
        result = install_skill_from_catalog(body.name.strip(), overwrite=body.overwrite)

    if not result.get("success"):
        code = result.get("code")
        err = str(result.get("error") or "install failed")
        if code == "not_found" or code == "not_in_catalog":
            raise HTTPException(status_code=404, detail=err)
        if code == "already_installed":
            raise HTTPException(status_code=409, detail=err)
        raise HTTPException(status_code=400, detail=err)

    store = get_store()
    store.audit(
        user_id,
        "skills.install_from_catalog",
        target_type="skill",
        target_id=body.name.strip(),
        workspace_id=workspace_id,
    )
    return result


@router.post("/{workspace_id}/skills")
def create_skill(
    workspace_id: str,
    body: SkillCreateBody,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    """Create a new user-owned skill in the caller's workspace."""
    _get_workspace(workspace_id, user_id)
    from gateway.web.tools.sandboxed_skill_manage import create_user_skill

    with enter_user_context(user_id):
        result = create_user_skill(
            body.name.strip(),
            body.skill_md,
            category=body.category.strip(),
        )
    if not result.get("success"):
        code = result.get("code")
        err = str(result.get("error") or "create failed")
        if code == "already_installed":
            raise HTTPException(status_code=409, detail=err)
        raise HTTPException(status_code=400, detail=err)
    return result


@router.put("/{workspace_id}/skills/{skill_name}")
def replace_skill(
    workspace_id: str,
    skill_name: str,
    body: SkillWriteBody,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    """Replace SKILL.md for a user skill (forks global into workspace)."""
    _get_workspace(workspace_id, user_id)
    from gateway.web.tools.sandboxed_skill_manage import write_user_skill

    with enter_user_context(user_id):
        result = write_user_skill(skill_name.strip(), body.skill_md)
    if not result.get("success"):
        err = str(result.get("error") or "write failed")
        if "not found" in err.lower():
            raise HTTPException(status_code=404, detail=err)
        raise HTTPException(status_code=400, detail=err)
    return result


@router.delete("/{workspace_id}/skills/{skill_name}")
def remove_skill(
    workspace_id: str,
    skill_name: str,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    """Delete a user-owned skill; global catalog skills are read-only."""
    _get_workspace(workspace_id, user_id)
    from gateway.web.tools.sandboxed_skill_manage import delete_user_skill

    with enter_user_context(user_id):
        result = delete_user_skill(skill_name.strip())
    if not result.get("success"):
        err = str(result.get("error") or "delete failed")
        if "not found" in err.lower():
            raise HTTPException(status_code=404, detail=err)
        if "read-only" in err.lower() or "global" in err.lower():
            raise HTTPException(status_code=403, detail=err)
        raise HTTPException(status_code=400, detail=err)
    return result


@router.get("/{workspace_id}/skills/{skill_name}")
def get_skill(
    workspace_id: str,
    skill_name: str,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    """Preview a skill's metadata + SKILL.md (user overlay wins)."""
    _get_workspace(workspace_id, user_id)
    with enter_user_context(user_id):
        from gateway.web.tools.sandboxed_skill_manage import _find_skill

        located = _find_skill(skill_name)
        if not located:
            raise HTTPException(status_code=404, detail="not found")
        skill_dir, source = located
        skill_md = skill_dir / "SKILL.md"
        try:
            content = skill_md.read_text(encoding="utf-8")
        except OSError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    meta: dict[str, Any] = {}
    if content.startswith("---"):
        parts = content.split("---", 2)
        try:
            meta = yaml.safe_load(parts[1]) or {} if len(parts) >= 3 else {}
        except yaml.YAMLError:
            meta = {}

    return {
        "name": str(meta.get("name") or skill_name),
        "source": source,
        "category": skill_dir.parent.name,
        "description": meta.get("description") or "",
        "path": str(skill_dir),
        "content": content,
    }


@router.patch("/{workspace_id}/skills/{skill_name}")
def patch_skill(
    workspace_id: str,
    skill_name: str,
    body: SkillPatch,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    ws = _get_workspace(workspace_id, user_id)
    store = get_store()
    from gateway.web.platform.database import session_scope

    with session_scope(store._engine) as db:
        row = db.execute(
            select(SkillEntitlement).where(
                SkillEntitlement.workspace_id == workspace_id,
                SkillEntitlement.skill_name == skill_name,
            )
        ).scalar_one_or_none()
        if row is None:
            row = SkillEntitlement(
                tenant_id=ws.tenant_id,
                workspace_id=workspace_id,
                skill_name=skill_name,
                enabled=True if body.enabled is None else body.enabled,
                config=body.config or {},
            )
            db.add(row)
        else:
            if body.enabled is not None:
                row.enabled = body.enabled
            if body.config is not None:
                row.config = body.config
    return {"name": skill_name, "enabled": body.enabled, "config": body.config}


def _get_workspace(workspace_id: str, user_id: str) -> Workspace:
    store = get_store()
    with store._session_factory() as db:
        ws = db.get(Workspace, workspace_id)
        if not ws or ws.owner_id != user_id:
            raise HTTPException(status_code=404, detail="not found")
        return ws


def _load_entitlements(workspace_id: str) -> dict[str, dict[str, Any]]:
    store = get_store()
    with store._session_factory() as db:
        rows = db.execute(
            select(SkillEntitlement).where(SkillEntitlement.workspace_id == workspace_id)
        ).scalars()
        return {
            r.skill_name: {"enabled": r.enabled, "config": r.config or {}}
            for r in rows
        }


def _scan_skills(root: Path, *, source: str) -> List[dict[str, Any]]:
    if not root.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for skill_md in root.rglob("SKILL.md"):
        try:
            text = skill_md.read_text(encoding="utf-8")
            if text.startswith("---"):
                # Frontmatter: ---\n<yaml>\n---
                parts = text.split("---", 2)
                meta = yaml.safe_load(parts[1]) or {} if len(parts) >= 3 else {}
            else:
                meta = {}
            name = str(meta.get("name") or skill_md.parent.name)
            out.append({
                "name": name,
                "source": source,
                "category": skill_md.parent.parent.name if skill_md.parent.parent != root else "",
                "path": str(skill_md.parent),
                "description": meta.get("description", ""),
            })
        except (OSError, yaml.YAMLError):
            continue
    return out
