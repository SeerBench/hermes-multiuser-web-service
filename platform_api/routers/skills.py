"""Skill entitlements + global skill listing."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, List, Optional

import yaml
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from gateway.web.platform.models import SkillEntitlement, Workspace
from gateway.web.sandbox import enter_user_context
from hermes_constants import get_hermes_home
from platform_api.deps import get_current_user_id, get_store

router = APIRouter(prefix="/workspaces", tags=["skills"])


class SkillPatch(BaseModel):
    enabled: Optional[bool] = None
    config: Optional[dict[str, Any]] = None


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
                "path": str(skill_md.parent),
                "description": meta.get("description", ""),
            })
        except (OSError, yaml.YAMLError):
            continue
    return out
