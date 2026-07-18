"""Skill Center API — entitlements, catalog install, structured create."""

from __future__ import annotations

from pathlib import Path
from typing import Any, List, Optional

import yaml
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select

from gateway.web.platform.models import SkillEntitlement, Workspace
from gateway.web.sandbox import enter_user_context
from gateway.web.skill_filters import is_web_excluded_skill
from hermes_constants import get_hermes_home
from platform_api.deps import get_current_user_id, get_store
from platform_api.services import skill_center as sc

router = APIRouter(prefix="/workspaces", tags=["skills"])


class SkillPatch(BaseModel):
    enabled: Optional[bool] = None
    config: Optional[dict[str, Any]] = None


class InstallFromCatalogBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    overwrite: bool = False


class SkillCreateBody(BaseModel):
    """Either provide full ``skill_md`` or structured fields for generation."""

    name: str = Field(..., min_length=1, max_length=64)
    skill_md: Optional[str] = None
    category: str = Field(default="productivity", min_length=1, max_length=64)
    description: Optional[str] = None
    workflow: Optional[str] = None
    inputs: Optional[str] = None
    outputs: Optional[str] = None
    type: str = "assistant"
    version: str = "1.0"
    config: Optional[dict[str, Any]] = None

    @model_validator(mode="after")
    def _require_md_or_structured(self) -> "SkillCreateBody":
        if self.skill_md and self.skill_md.strip():
            return self
        if self.description and self.description.strip():
            return self
        raise ValueError("provide skill_md or description for structured create")


class SkillWriteBody(BaseModel):
    skill_md: str = Field(..., min_length=1)


@router.get("/{workspace_id}/skills")
def list_skills(workspace_id: str, user_id: str = Depends(get_current_user_id)) -> List[dict[str, Any]]:
    ws = _get_workspace(workspace_id, user_id)
    del ws
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
        enabled = bool(s.get("enabled", True))
        s["enabled"] = enabled
        s["status"] = sc.status_from_enabled(enabled)
        s.setdefault("version", None)
        s.setdefault("type", "assistant")
        s.setdefault("updated_at", None)
        s.setdefault("config", {})
    visible = [
        s for s in merged.values()
        if not is_web_excluded_skill(
            name=s.get("name"),
            category=s.get("category"),
        )
    ]
    return sorted(visible, key=lambda x: x["name"])


@router.post("/{workspace_id}/skills/install-from-catalog")
def install_from_catalog(
    workspace_id: str,
    body: InstallFromCatalogBody,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    """Copy a global catalog skill into the caller's private workspace."""
    _get_workspace(workspace_id, user_id)
    from gateway.web.tools.sandboxed_skill_manage import install_skill_from_catalog

    if is_web_excluded_skill(name=body.name.strip()):
        raise HTTPException(
            status_code=404,
            detail=f"skill {body.name.strip()!r} is not available on web-chat (macOS-only)",
        )

    with enter_user_context(user_id):
        result = install_skill_from_catalog(body.name.strip(), overwrite=body.overwrite)

    if not result.get("success"):
        code = result.get("code")
        err = str(result.get("error") or "install failed")
        if code in ("not_found", "not_in_catalog", "web_excluded"):
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
    """Create a user-owned skill (raw SKILL.md or structured fields)."""
    _get_workspace(workspace_id, user_id)
    from gateway.web.tools.sandboxed_skill_manage import create_user_skill

    name = body.name.strip()
    # Allow display names from the form — slugify unless already valid.
    if not re_match_name(name):
        name = sc.slugify_skill_name(name)

    try:
        if body.skill_md and body.skill_md.strip():
            skill_md = body.skill_md
        else:
            skill_md = sc.build_skill_md(
                name=name,
                description=body.description or "",
                workflow=body.workflow or "",
                inputs=body.inputs or "",
                outputs=body.outputs or "",
                skill_type=body.type,
                version=body.version,
            )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None

    with enter_user_context(user_id):
        result = create_user_skill(
            name,
            skill_md,
            category=body.category.strip(),
        )
        if result.get("success") and body.config is not None:
            from gateway.web.sandbox import get_user_workspace

            ws_root = get_user_workspace()
            skill_dir = sc.find_user_skill_dir(ws_root, name)
            if skill_dir is not None:
                sc.write_config_json(skill_dir, body.config)

    if not result.get("success"):
        code = result.get("code")
        err = str(result.get("error") or "create failed")
        if code == "already_installed":
            raise HTTPException(status_code=409, detail=err)
        raise HTTPException(status_code=400, detail=err)

    if body.config is not None:
        _upsert_entitlement(
            workspace_id, user_id, name, enabled=True, config=body.config
        )

    store = get_store()
    store.audit(
        user_id,
        "skills.create",
        target_type="skill",
        target_id=name,
        workspace_id=workspace_id,
    )
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
    store = get_store()
    store.audit(
        user_id,
        "skills.update",
        target_type="skill",
        target_id=skill_name.strip(),
        workspace_id=workspace_id,
    )
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
    store = get_store()
    store.audit(
        user_id,
        "skills.delete",
        target_type="skill",
        target_id=skill_name.strip(),
        workspace_id=workspace_id,
    )
    return result


@router.get("/{workspace_id}/skills/{skill_name}")
def get_skill(
    workspace_id: str,
    skill_name: str,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    """Preview a skill's metadata + SKILL.md (user overlay wins)."""
    _get_workspace(workspace_id, user_id)
    if is_web_excluded_skill(name=skill_name.strip()):
        raise HTTPException(status_code=404, detail="not found")
    with enter_user_context(user_id):
        from gateway.web.tools.sandboxed_skill_manage import _find_skill

        located = _find_skill(skill_name)
        if not located:
            raise HTTPException(status_code=404, detail="not found")
        skill_dir, source = located
        skill_md_path = skill_dir / "SKILL.md"
        try:
            content = skill_md_path.read_text(encoding="utf-8")
        except OSError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        disk_config = sc.read_config_json(skill_dir)
        category = skill_dir.parent.name

    meta: dict[str, Any] = {}
    if content.startswith("---"):
        parts = content.split("---", 2)
        try:
            meta = yaml.safe_load(parts[1]) or {} if len(parts) >= 3 else {}
        except yaml.YAMLError:
            meta = {}
    if not isinstance(meta, dict):
        meta = {}

    if is_web_excluded_skill(
        category=category,
        name=str(meta.get("name") or skill_name),
        frontmatter=meta,
    ):
        raise HTTPException(status_code=404, detail="not found")

    extra = sc.enrich_skill_meta(skill_md_path, meta)
    ents = _load_entitlements(workspace_id)
    ent = ents.get(skill_name.strip()) or {}
    enabled = bool(ent["enabled"]) if ent else True
    config = ent["config"] if ent and ent.get("config") is not None else disk_config

    return {
        "name": str(meta.get("name") or skill_name),
        "source": source,
        "category": category,
        "description": meta.get("description") or "",
        "path": str(skill_dir),
        "content": content,
        "version": extra.get("version"),
        "type": extra.get("type"),
        "updated_at": extra.get("updated_at"),
        "enabled": enabled,
        "status": sc.status_from_enabled(enabled),
        "config": config or {},
    }


@router.patch("/{workspace_id}/skills/{skill_name}")
def patch_skill(
    workspace_id: str,
    skill_name: str,
    body: SkillPatch,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    if is_web_excluded_skill(name=skill_name.strip()):
        raise HTTPException(status_code=404, detail="not found")
    name = skill_name.strip()
    row = _upsert_entitlement(
        workspace_id,
        user_id,
        name,
        enabled=body.enabled,
        config=body.config,
    )

    if body.config is not None:
        with enter_user_context(user_id):
            from gateway.web.sandbox import get_user_workspace
            from gateway.web.tools.sandboxed_skill_manage import _find_skill

            located = _find_skill(name)
            if located and located[1] == "user":
                sc.write_config_json(located[0], body.config)
            else:
                # Global-only: still store config in DB; write sidecar if forked later.
                ws_root = get_user_workspace()
                skill_dir = sc.find_user_skill_dir(ws_root, name)
                if skill_dir is not None:
                    sc.write_config_json(skill_dir, body.config)

    action = "skills.config" if body.config is not None else "skills.patch"
    if body.enabled is True:
        action = "skills.enable"
    elif body.enabled is False:
        action = "skills.disable"
    store = get_store()
    store.audit(
        user_id,
        action,
        target_type="skill",
        target_id=name,
        workspace_id=workspace_id,
    )
    return {
        "name": name,
        "enabled": row["enabled"],
        "status": sc.status_from_enabled(row["enabled"]),
        "config": row["config"],
    }


@router.post("/{workspace_id}/skills/{skill_name}/enable")
def enable_skill(
    workspace_id: str,
    skill_name: str,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    return patch_skill(
        workspace_id,
        skill_name,
        SkillPatch(enabled=True),
        user_id=user_id,
    )


@router.post("/{workspace_id}/skills/{skill_name}/disable")
def disable_skill(
    workspace_id: str,
    skill_name: str,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    return patch_skill(
        workspace_id,
        skill_name,
        SkillPatch(enabled=False),
        user_id=user_id,
    )


def re_match_name(name: str) -> bool:
    import re

    return bool(re.match(r"^[A-Za-z0-9_-]{1,64}$", name))


def _upsert_entitlement(
    workspace_id: str,
    user_id: str,
    skill_name: str,
    *,
    enabled: Optional[bool] = None,
    config: Optional[dict[str, Any]] = None,
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
                enabled=True if enabled is None else enabled,
                config=config or {},
            )
            db.add(row)
        else:
            if enabled is not None:
                row.enabled = enabled
            if config is not None:
                row.config = config
        db.flush()
        return {"enabled": bool(row.enabled), "config": row.config or {}}


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
                parts = text.split("---", 2)
                meta = yaml.safe_load(parts[1]) or {} if len(parts) >= 3 else {}
            else:
                meta = {}
            name = str(meta.get("name") or skill_md.parent.name)
            category = (
                skill_md.parent.parent.name
                if skill_md.parent.parent != root
                else ""
            )
            if is_web_excluded_skill(
                category=category, name=name, frontmatter=meta,
            ):
                continue
            extra = sc.enrich_skill_meta(skill_md, meta if isinstance(meta, dict) else {})
            disk_cfg = sc.read_config_json(skill_md.parent) if source == "user" else {}
            out.append({
                "name": name,
                "source": source,
                "category": category,
                "path": str(skill_md.parent),
                "description": meta.get("description", "") if isinstance(meta, dict) else "",
                "version": extra.get("version"),
                "type": extra.get("type"),
                "updated_at": extra.get("updated_at"),
                "config": disk_cfg,
            })
        except (OSError, yaml.YAMLError):
            continue
    return out
