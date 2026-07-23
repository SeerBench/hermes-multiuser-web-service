"""Skill Center helpers — structured SKILL.md builder + config.json sync."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import yaml

SKILL_TYPES = frozenset({"tool", "workflow", "analysis", "assistant"})

_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_SLUG_RE = re.compile(r"[^A-Za-z0-9_-]+")


def slugify_skill_name(raw: str) -> str:
    """Turn a display name into a filesystem-safe skill id."""
    text = (raw or "").strip().lower().replace(" ", "-")
    text = _SLUG_RE.sub("-", text).strip("-_")
    if not text:
        text = "custom-skill"
    return text[:64]


def build_skill_md(
    *,
    name: str,
    description: str,
    workflow: str = "",
    inputs: str = "",
    outputs: str = "",
    skill_type: str = "assistant",
    version: str = "1.0",
) -> str:
    """Generate a valid Hermes SKILL.md from structured create-form fields."""
    if not _NAME_RE.match(name):
        raise ValueError(
            f"invalid skill name {name!r}; use letters, digits, -, _ (max 64)"
        )
    desc = (description or "").strip()
    if not desc:
        raise ValueError("description is required")
    st = (skill_type or "assistant").strip().lower()
    if st not in SKILL_TYPES:
        raise ValueError(f"invalid type: {skill_type}")
    ver = str(version or "1.0").strip() or "1.0"

    # Frontmatter description kept compact for listings.
    fm_desc = desc if len(desc) <= 60 else desc[:57].rstrip() + "..."

    title = name.replace("-", " ").replace("_", " ").title()
    procedure = (workflow or "").strip() or "1. Clarify the user goal.\n2. Execute steps.\n3. Summarize results."
    inputs_block = (inputs or "").strip() or "(none specified)"
    outputs_block = (outputs or "").strip() or "(none specified)"

    body = f"""# {title}

{desc}

## When to Use

Use this skill when the user's request matches: {desc}

## Procedure

{procedure}

## Inputs

{inputs_block}

## Outputs

{outputs_block}
"""
    frontmatter = {
        "name": name,
        "description": fm_desc,
        "version": ver,
        "type": st,
    }
    yaml_block = yaml.safe_dump(frontmatter, allow_unicode=True, sort_keys=False).strip()
    return f"---\n{yaml_block}\n---\n\n{body}"


def enrich_skill_meta(skill_md_path: Path, meta: dict[str, Any]) -> dict[str, Any]:
    """Add version / type / updated_at from frontmatter + file mtime."""
    version = meta.get("version")
    if version is not None:
        version = str(version)
    skill_type = meta.get("type")
    if not skill_type and isinstance(meta.get("metadata"), dict):
        hermes = meta["metadata"].get("hermes") or {}
        if isinstance(hermes, dict):
            skill_type = hermes.get("type")
    skill_type = str(skill_type or "assistant")
    updated_at = None
    try:
        ts = skill_md_path.stat().st_mtime
        updated_at = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
    except OSError:
        pass
    return {
        "version": version,
        "type": skill_type if skill_type in SKILL_TYPES else "assistant",
        "updated_at": updated_at,
    }


def status_from_enabled(enabled: bool) -> str:
    return "enabled" if enabled else "disabled"


def read_config_json(skill_dir: Path) -> dict[str, Any]:
    path = skill_dir / "config.json"
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def write_config_json(skill_dir: Path, config: dict[str, Any]) -> None:
    skill_dir.mkdir(parents=True, exist_ok=True)
    path = skill_dir / "config.json"
    path.write_text(
        json.dumps(config or {}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def find_user_skill_dir(workspace_root: Path, skill_name: str) -> Optional[Path]:
    root = workspace_root / "skills"
    if not root.is_dir():
        return None
    for skill_md in root.rglob("SKILL.md"):
        if skill_md.parent.name == skill_name:
            return skill_md.parent
    return None
