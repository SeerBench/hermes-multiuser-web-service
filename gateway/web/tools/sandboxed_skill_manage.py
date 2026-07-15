"""Sandboxed skill management tools for the ``web_chat`` platform.

Adds tools — ``web_skills_list``, ``web_skill_view``,
``web_skill_install``, ``web_skill_delete``, ``web_skill_edit``,
``web_skill_patch`` — that let an authenticated web user manage skills
inside their per-user workspace, without bleeding across tenants and
without touching upstream ``tools/skills_tool.py``.

Why a separate, fork-native implementation
------------------------------------------
``tools/skills_tool.py:91`` evaluates ``SKILLS_DIR = HERMES_HOME / "skills"``
at import time — a module-level constant that does **not** observe the
``HERMES_HOME`` override set by :func:`gateway.web.sandbox.enter_user_context`.
Any write through upstream ``skill_manage`` therefore lands in the
process-global ``~/.hermes/skills/`` and is visible to every other user.

Rather than patch upstream (which would touch ~12 references and break
Strategy 2 / "zero upstream changes"), this module re-implements the
minimal scan/read/write logic needed for a per-user skill surface, using
the existing :func:`confine_path` sandbox primitive for path safety.

Discovery semantics
-------------------
Per the design doc (``docs/plans/2026-05-26-per-user-skill-isolation.md``):

- **List/view** merges global (``$HERMES_HOME/skills/``, operator-curated)
  with the user's workspace (``<ws>/skills/``) — on name collision the
  user version overlays the global.
- **Install/delete/edit/patch** only ever touch ``<ws>/skills/``. The
  global library is read-only for web users. Editing a global-only skill
  **forks** a private copy into the workspace first (copy-on-write).
- User-installed skills are **not** auto-injected into the agent's system
  prompt (upstream's ``prompt_builder.py`` doesn't observe ContextVars).
  The agent discovers them on demand by calling ``web_skills_list``.

Side-effect import
------------------
``gateway/web/tools/__init__.py`` imports this module so registration
fires at gateway startup. The tools are listed in
``toolsets.py::hermes-web-chat``, replacing upstream ``skills_list`` /
``skill_view`` for the web platform.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

import yaml

from gateway.web.sandbox import (
    PathSandboxViolation,
    confine_path,
    get_user_workspace,
)
from gateway.web.skill_filters import is_web_excluded_skill
from tools.registry import registry

logger = logging.getLogger("hermes.web.tools.sandboxed_skill_manage")

_TOOLSET = "web_skill"

# Per-file and per-skill size caps. Picked to comfortably fit a SKILL.md
# plus a handful of reference docs while keeping the per-user disk
# footprint predictable. Override path: when gateway/web/quota.py lands,
# replace the bare check with a quota-counter call (see TODO below).
MAX_FILE_BYTES = 64 * 1024
MAX_SKILL_BYTES = 256 * 1024

# Skill name shape: short, filesystem-safe, no '..' or path separators.
# Mirrors upstream's ``name`` length cap of 64.
_SKILL_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# Category allowlist — kept in sync with the de-facto top-level
# subdirectories under ``~/.hermes/skills/`` as of fork creation. The
# allowlist keeps `web_skills_list` output tidy and stops users from
# fragmenting the namespace with one-off categories.
# ``apple`` deliberately omitted — macOS-only skills are filtered out of the
# web surface (see ``gateway.web.skill_filters``).
_ALLOWED_CATEGORIES: frozenset[str] = frozenset({
    "autonomous-ai-agents", "creative", "data-science",
    "devops", "diagramming", "dogfood", "domain", "email", "gaming",
    "gifs", "github", "mcp", "media", "mlops", "note-taking",
    "productivity", "red-teaming", "research", "smart-home",
    "social-media", "software-development", "yuanbao",
})

# Pattern that matches an SKILL.md beginning with YAML frontmatter
# delimited by '---' on its own line. Body capture group is unused but
# kept for symmetry with possible future use.
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)


# ── Path helpers ───────────────────────────────────────────────────────


def _real_global_skills_dir() -> Path:
    """Global skills dir at the **process-wide** ``HERMES_HOME``, ignoring
    the per-user ContextVar override.

    ``enter_user_context`` sets ``_HERMES_HOME_OVERRIDE`` (a ContextVar)
    to redirect ``get_hermes_home()`` to the user's workspace.  We want
    the *un-overridden* value here so the global skill library can be
    read alongside the user's private one — so we go straight to the
    underlying env var (the same source ``get_hermes_home()`` reads from
    before the override path).  The ContextVar override never mutates
    ``os.environ``, so ``os.environ["HERMES_HOME"]`` is exactly the
    operator-configured global path.  Falls back to ``~/.hermes`` to
    match upstream's default.
    """
    env_home = os.environ.get("HERMES_HOME", "").strip()
    if env_home:
        return Path(env_home) / "skills"
    return Path.home() / ".hermes" / "skills"


def _user_skills_dir() -> Optional[Path]:
    """Per-user workspace skills dir, or None outside a user context."""
    ws = get_user_workspace()
    if ws is None:
        return None
    return ws / "skills"


# ── Frontmatter parsing + scan ─────────────────────────────────────────


def _parse_frontmatter(text: str) -> Optional[Dict[str, Any]]:
    """Extract YAML frontmatter from a SKILL.md body. Returns the parsed
    dict, or ``None`` if there is no frontmatter or it is not a mapping.
    """
    match = _FRONTMATTER_RE.match(text)
    if not match:
        return None
    try:
        data = yaml.safe_load(match.group(1))
    except yaml.YAMLError:
        return None
    if not isinstance(data, dict):
        return None
    return data


def _scan_skills_dir(root: Path) -> Iterator[Tuple[str, str, str]]:
    """Walk ``root/<category>/<name>/SKILL.md`` and yield triples of
    ``(name, category, description)``.

    Silently skips malformed entries (missing frontmatter, missing name,
    unreadable files) — listing should never crash because one rogue
    skill on disk has a broken frontmatter.
    """
    if not root.exists() or not root.is_dir():
        return
    for category_dir in sorted(root.iterdir()):
        if not category_dir.is_dir():
            continue
        category = category_dir.name
        for skill_dir in sorted(category_dir.iterdir()):
            if not skill_dir.is_dir():
                continue
            skill_md = skill_dir / "SKILL.md"
            if not skill_md.is_file():
                continue
            try:
                text = skill_md.read_text(encoding="utf-8")
            except OSError:
                continue
            meta = _parse_frontmatter(text)
            if not meta:
                continue
            name = meta.get("name")
            desc = meta.get("description", "")
            if not isinstance(name, str) or not name.strip():
                continue
            name = name.strip()
            # Hide Apple / macOS-only skills from the web agent surface.
            if is_web_excluded_skill(
                category=category, name=name, frontmatter=meta,
            ):
                continue
            yield name, category, str(desc).strip()


def _validate_skill_md(
    text: str, expected_name: str
) -> Tuple[bool, Any]:
    """Validate a SKILL.md body for an install request.

    Returns ``(True, meta_dict)`` on success, or ``(False, error_msg)``
    on rejection. The caller's responsibility is to surface ``error_msg``
    verbatim — it is already user-facing.
    """
    meta = _parse_frontmatter(text)
    if meta is None:
        return False, "SKILL.md must begin with YAML frontmatter delimited by '---' lines"
    name = meta.get("name")
    if not isinstance(name, str) or not name.strip():
        return False, "SKILL.md frontmatter missing 'name'"
    name = name.strip()
    if name != expected_name:
        return (
            False,
            f"SKILL.md frontmatter name {name!r} does not match install argument name {expected_name!r}",
        )
    if not _SKILL_NAME_RE.match(name):
        return False, "skill name must match ^[A-Za-z0-9_-]{1,64}$"
    desc = meta.get("description")
    if not isinstance(desc, str) or not desc.strip():
        return False, "SKILL.md frontmatter missing 'description'"
    if len(desc) > 1024:
        return False, "SKILL.md 'description' exceeds 1024 chars"
    if meta.get("version") is None:
        return False, "SKILL.md frontmatter missing 'version'"
    return True, meta


# ── JSON helpers ───────────────────────────────────────────────────────


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _error_no_context() -> str:
    return _json({
        "success": False,
        "error": "internal sandbox not initialised",
    })


# ── Skill lookup ───────────────────────────────────────────────────────


def _find_skill(name: str) -> Optional[Tuple[Path, str]]:
    """Locate a skill by name, user layer first then global.

    Returns ``(skill_dir, source)`` where ``source`` is ``"user"`` or
    ``"global"``, or ``None`` if the name is not found anywhere.
    """
    if not _SKILL_NAME_RE.match(name):
        return None
    user_dir = _user_skills_dir()
    if user_dir is not None and user_dir.exists():
        for category_dir in user_dir.iterdir():
            if not category_dir.is_dir():
                continue
            candidate = category_dir / name
            if (candidate / "SKILL.md").is_file():
                return candidate, "user"
    global_dir = _real_global_skills_dir()
    if global_dir.exists():
        for category_dir in global_dir.iterdir():
            if not category_dir.is_dir():
                continue
            candidate = category_dir / name
            if (candidate / "SKILL.md").is_file():
                return candidate, "global"
    return None


def _skill_total_bytes(skill_dir: Path) -> int:
    return sum(p.stat().st_size for p in skill_dir.rglob("*") if p.is_file())


def _copy_skill_tree(src: Path, dest: Path) -> Tuple[bool, str]:
    """Copy a skill directory with size caps. Returns ``(ok, error_or_empty)``."""
    total = 0
    for path in src.rglob("*"):
        if not path.is_file():
            continue
        size = path.stat().st_size
        if size > MAX_FILE_BYTES:
            return False, f"file {path.relative_to(src)} exceeds the {MAX_FILE_BYTES}-byte per-file limit"
        total += size
        if total > MAX_SKILL_BYTES:
            return False, f"skill total size exceeds the {MAX_SKILL_BYTES}-byte cap"

    if dest.exists():
        shutil.rmtree(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, dest)
    return True, ""


def install_skill_from_catalog(
    name: str,
    *,
    overwrite: bool = False,
) -> Dict[str, Any]:
    """Copy a global catalog skill into the active user's workspace.

    Must be called inside :func:`enter_user_context`. Returns a result
    dict (not JSON) for reuse by the Platform API and agent tools.
    """
    ws = get_user_workspace()
    if ws is None:
        return {"success": False, "error": "internal sandbox not initialised"}

    if not isinstance(name, str) or not _SKILL_NAME_RE.match(name):
        return {"success": False, "error": f"invalid skill name {name!r}"}

    located = _find_skill(name)
    if not located:
        return {"success": False, "error": f"skill {name!r} not found in catalog", "code": "not_found"}

    skill_dir, source = located
    try:
        meta = _parse_frontmatter((skill_dir / "SKILL.md").read_text(encoding="utf-8")) or {}
    except OSError:
        meta = {}
    if is_web_excluded_skill(
        category=skill_dir.parent.name, name=name, frontmatter=meta,
    ):
        return {
            "success": False,
            "error": f"skill {name!r} is not available on web-chat (macOS-only)",
            "code": "web_excluded",
        }

    if source == "user" and not overwrite:
        return {
            "success": False,
            "error": (
                f"skill {name!r} is already in your workspace; "
                "pass overwrite=true to reinstall from the global catalog"
            ),
            "code": "already_installed",
        }

    # Prefer the global catalog as the copy source so overwrite reinstalls
    # a fresh operator-curated copy rather than cloning the private one.
    global_dir = _real_global_skills_dir()
    global_located: Optional[Path] = None
    category = skill_dir.parent.name
    if global_dir.exists():
        for category_dir in global_dir.iterdir():
            if not category_dir.is_dir():
                continue
            candidate = category_dir / name
            if (candidate / "SKILL.md").is_file():
                global_located = candidate
                category = category_dir.name
                break

    if global_located is None:
        return {
            "success": False,
            "error": f"skill {name!r} is not in the global catalog (user-only skills cannot be reinstalled from catalog)",
            "code": "not_in_catalog",
        }

    if category not in _ALLOWED_CATEGORIES:
        # Still allow copy of operator-curated categories even if allowlist drifts.
        pass

    dest = ws / "skills" / category / name
    try:
        confine_path(dest)
    except PathSandboxViolation as exc:
        return {"success": False, "error": f"target dir outside workspace: {exc}"}
    except RuntimeError:
        return {"success": False, "error": "internal sandbox not initialised"}

    ok, err = _copy_skill_tree(global_located, dest)
    if not ok:
        return {"success": False, "error": err}

    return {
        "success": True,
        "name": name,
        "category": category,
        "source": "user",
        "bytes_written": _skill_total_bytes(dest),
        "overwritten": source == "user",
    }


def _ensure_user_skill(name: str) -> Tuple[Optional[Path], bool, Optional[str]]:
    """Return a writable user skill dir, forking from global if needed.

    Returns ``(skill_dir, forked, error_message)``.
    """
    located = _find_skill(name)
    if not located:
        return None, False, f"skill {name!r} not found"
    skill_dir, source = located
    if source == "user":
        return skill_dir, False, None

    # Fork global → user before mutating.
    result = install_skill_from_catalog(name, overwrite=False)
    if not result.get("success"):
        return None, False, str(result.get("error") or "fork failed")
    forked = _find_skill(name)
    if not forked or forked[1] != "user":
        return None, False, "fork completed but skill not found in workspace"
    return forked[0], True, None


# ── Handlers ───────────────────────────────────────────────────────────


def _handle_web_skills_list(args: Dict[str, Any], **kw: Any) -> str:
    ws = get_user_workspace()
    if ws is None:
        return _error_no_context()

    category_filter = args.get("category")
    if category_filter is not None and not isinstance(category_filter, str):
        return _json({"success": False, "error": "'category' must be a string"})

    source_filter = args.get("source", "all")
    if source_filter not in ("all", "global", "user"):
        return _json({
            "success": False,
            "error": f"invalid source filter {source_filter!r} (must be 'all', 'global', or 'user')",
        })

    user_root = ws / "skills"
    user_entries = list(_scan_skills_dir(user_root))
    global_entries: List[Tuple[str, str, str]] = []
    if source_filter != "user":
        global_entries = list(_scan_skills_dir(_real_global_skills_dir()))

    user_names = {name for name, _c, _d in user_entries}

    skills: List[Dict[str, Any]] = []
    if source_filter in ("all", "user"):
        for name, category, desc in user_entries:
            if category_filter and category != category_filter:
                continue
            skills.append({
                "name": name,
                "description": desc,
                "category": category,
                "source": "user",
            })
    if source_filter in ("all", "global"):
        for name, category, desc in global_entries:
            # User-overlay hides the global counterpart in the merged view.
            if source_filter == "all" and name in user_names:
                continue
            if category_filter and category != category_filter:
                continue
            skills.append({
                "name": name,
                "description": desc,
                "category": category,
                "source": "global",
            })

    categories = sorted({s["category"] for s in skills})
    return _json({
        "success": True,
        "skills": skills,
        "categories": categories,
    })


def _handle_web_skill_view(args: Dict[str, Any], **kw: Any) -> str:
    ws = get_user_workspace()
    if ws is None:
        return _error_no_context()

    name = args.get("name")
    if not isinstance(name, str) or not name.strip():
        return _json({"success": False, "error": "web_skill_view: missing required 'name'"})
    name = name.strip()
    if not _SKILL_NAME_RE.match(name):
        return _json({"success": False, "error": f"invalid skill name {name!r}"})

    located = _find_skill(name)
    if not located:
        return _json({"success": False, "error": f"skill {name!r} not found", "name": name})
    skill_dir, source = located
    try:
        view_meta = _parse_frontmatter((skill_dir / "SKILL.md").read_text(encoding="utf-8")) or {}
    except OSError:
        view_meta = {}
    if is_web_excluded_skill(
        category=skill_dir.parent.name, name=name, frontmatter=view_meta,
    ):
        return _json({
            "success": False,
            "error": f"skill {name!r} is not available on web-chat (macOS-only)",
            "name": name,
        })

    file_path = args.get("file_path")
    if file_path:
        if not isinstance(file_path, str):
            return _json({"success": False, "error": "file_path must be a string"})
        rel = Path(file_path)
        if rel.is_absolute() or ".." in rel.parts:
            return _json({
                "success": False,
                "error": "file_path must be relative and must not contain '..'",
            })
        target = (skill_dir / rel).resolve(strict=False)
        try:
            target.relative_to(skill_dir.resolve(strict=False))
        except ValueError:
            return _json({"success": False, "error": "file_path escapes the skill directory"})
        if not target.is_file():
            return _json({
                "success": False,
                "error": f"file {file_path!r} not found under skill {name!r}",
            })
    else:
        target = skill_dir / "SKILL.md"

    try:
        content = target.read_text(encoding="utf-8")
    except OSError as exc:
        return _json({"success": False, "error": f"could not read skill file: {exc}"})

    return _json({
        "success": True,
        "name": name,
        "source": source,
        "file_path": file_path or "SKILL.md",
        "content": content,
    })


def _handle_web_skill_install(args: Dict[str, Any], **kw: Any) -> str:
    ws = get_user_workspace()
    if ws is None:
        return _error_no_context()

    name = args.get("name")
    if not isinstance(name, str) or not _SKILL_NAME_RE.match(name):
        return _json({
            "success": False,
            "error": "name must match ^[A-Za-z0-9_-]{1,64}$",
        })

    category = args.get("category")
    if not isinstance(category, str) or category not in _ALLOWED_CATEGORIES:
        return _json({
            "success": False,
            "error": f"category {category!r} is not in the allowed set",
            "allowed_categories": sorted(_ALLOWED_CATEGORIES),
        })

    skill_md = args.get("skill_md")
    if not isinstance(skill_md, str) or not skill_md.strip():
        return _json({"success": False, "error": "skill_md must be a non-empty string"})

    ok, meta_or_err = _validate_skill_md(skill_md, expected_name=name)
    if not ok:
        return _json({"success": False, "error": meta_or_err})

    files = args.get("files") or {}
    if not isinstance(files, dict):
        return _json({"success": False, "error": "files must be a dict of {relpath: content}"})

    overwrite = bool(args.get("overwrite", False))

    skill_md_bytes = skill_md.encode("utf-8")
    if len(skill_md_bytes) > MAX_FILE_BYTES:
        return _json({
            "success": False,
            "error": f"SKILL.md exceeds the {MAX_FILE_BYTES}-byte per-file limit",
        })

    target_dir = ws / "skills" / category / name
    try:
        confined_target = confine_path(target_dir)
    except PathSandboxViolation as exc:
        return _json({"success": False, "error": f"target dir outside workspace: {exc}"})
    except RuntimeError:
        return _error_no_context()

    total = len(skill_md_bytes)
    side_files: List[Tuple[Path, bytes]] = []
    confined_resolved = confined_target.resolve(strict=False)
    for relpath, content in files.items():
        if not isinstance(relpath, str) or not relpath:
            return _json({"success": False, "error": f"invalid file relpath {relpath!r}"})
        if not isinstance(content, str):
            return _json({
                "success": False,
                "error": f"file {relpath!r} content must be a string",
            })
        rel = Path(relpath)
        if rel.is_absolute() or ".." in rel.parts:
            return _json({
                "success": False,
                "error": f"file relpath {relpath!r} must be relative and must not contain '..'",
            })
        # SKILL.md must come through the skill_md argument so frontmatter
        # validation can't be sidestepped via files{}.
        if rel == Path("SKILL.md"):
            return _json({
                "success": False,
                "error": "use the skill_md argument for SKILL.md, not files{}",
            })
        target_file = (confined_target / rel).resolve(strict=False)
        try:
            target_file.relative_to(confined_resolved)
        except ValueError:
            return _json({
                "success": False,
                "error": f"file {relpath!r} escapes the skill directory",
            })
        cb = content.encode("utf-8")
        if len(cb) > MAX_FILE_BYTES:
            return _json({
                "success": False,
                "error": f"file {relpath!r} exceeds the {MAX_FILE_BYTES}-byte per-file limit",
            })
        total += len(cb)
        if total > MAX_SKILL_BYTES:
            return _json({
                "success": False,
                "error": f"skill total size exceeds the {MAX_SKILL_BYTES}-byte cap",
            })
        side_files.append((target_file, cb))

    if confined_target.exists():
        if not overwrite:
            return _json({
                "success": False,
                "error": (
                    f"skill {name!r} already exists in your workspace; "
                    "pass overwrite=true to replace it"
                ),
            })
        shutil.rmtree(confined_target)

    confined_target.mkdir(parents=True, exist_ok=True)
    (confined_target / "SKILL.md").write_bytes(skill_md_bytes)
    for target_file, cb in side_files:
        target_file.parent.mkdir(parents=True, exist_ok=True)
        target_file.write_bytes(cb)

    # No local quota counter — the fork dropped its local quota module
    # in commit 2751078b8 ("feat(web_chat)!: replace local auth with
    # new-api key login, drop quota").  Usage billing is the upstream
    # new-api gateway's responsibility.  The per-file MAX_FILE_BYTES /
    # per-skill MAX_SKILL_BYTES caps above bound the per-tenant disk
    # footprint without any local accounting.

    return _json({
        "success": True,
        "name": name,
        "category": category,
        "source": "user",
        "bytes_written": total,
        "files": 1 + len(side_files),
    })


def _handle_web_skill_delete(args: Dict[str, Any], **kw: Any) -> str:
    ws = get_user_workspace()
    if ws is None:
        return _error_no_context()

    name = args.get("name")
    if not isinstance(name, str) or not _SKILL_NAME_RE.match(name):
        return _json({"success": False, "error": "invalid skill name"})

    located = _find_skill(name)
    if not located:
        return _json({"success": False, "error": f"skill {name!r} not found"})
    skill_dir, source = located
    if source == "global":
        return _json({
            "success": False,
            "error": (
                f"skill {name!r} is a global, operator-curated skill — "
                "it is read-only and cannot be deleted by users"
            ),
        })

    # Belt-and-braces: confine_path before rmtree so any contrived
    # symlink in the user dir that escapes the workspace is caught.
    try:
        confine_path(skill_dir)
    except PathSandboxViolation:
        return _json({
            "success": False,
            "error": "skill directory resolved outside your workspace; refusing to delete",
        })
    except RuntimeError:
        return _error_no_context()

    deleted_bytes = sum(p.stat().st_size for p in skill_dir.rglob("*") if p.is_file())
    shutil.rmtree(skill_dir)
    return _json({
        "success": True,
        "name": name,
        "deleted_bytes": deleted_bytes,
    })


def _handle_web_skill_edit(args: Dict[str, Any], **kw: Any) -> str:
    """Full rewrite of SKILL.md; forks global skills into the workspace."""
    ws = get_user_workspace()
    if ws is None:
        return _error_no_context()

    name = args.get("name")
    skill_md = args.get("skill_md")
    if not isinstance(name, str) or not name.strip():
        return _json({"success": False, "error": "web_skill_edit: missing required 'name'"})
    name = name.strip()
    if not _SKILL_NAME_RE.match(name):
        return _json({"success": False, "error": f"invalid skill name {name!r}"})
    if not isinstance(skill_md, str) or not skill_md.strip():
        return _json({"success": False, "error": "web_skill_edit: missing required 'skill_md'"})

    ok, meta_or_err = _validate_skill_md(skill_md, name)
    if not ok:
        return _json({"success": False, "error": meta_or_err})

    skill_md_bytes = skill_md.encode("utf-8")
    if len(skill_md_bytes) > MAX_FILE_BYTES:
        return _json({
            "success": False,
            "error": f"SKILL.md exceeds the {MAX_FILE_BYTES}-byte per-file limit",
        })

    skill_dir, forked, err = _ensure_user_skill(name)
    if err or skill_dir is None:
        return _json({"success": False, "error": err or "skill not found"})

    try:
        confine_path(skill_dir)
    except PathSandboxViolation:
        return _json({"success": False, "error": "skill directory resolved outside your workspace"})
    except RuntimeError:
        return _error_no_context()

    target = skill_dir / "SKILL.md"
    # Size after rewrite (other files unchanged).
    other = sum(
        p.stat().st_size
        for p in skill_dir.rglob("*")
        if p.is_file() and p.name != "SKILL.md"
    )
    if other + len(skill_md_bytes) > MAX_SKILL_BYTES:
        return _json({
            "success": False,
            "error": f"skill total size exceeds the {MAX_SKILL_BYTES}-byte cap",
        })

    target.write_bytes(skill_md_bytes)
    return _json({
        "success": True,
        "name": name,
        "source": "user",
        "forked": forked,
        "bytes_written": len(skill_md_bytes),
    })


def _handle_web_skill_patch(args: Dict[str, Any], **kw: Any) -> str:
    """Targeted find-and-replace; forks global skills into the workspace."""
    ws = get_user_workspace()
    if ws is None:
        return _error_no_context()

    name = args.get("name")
    old_string = args.get("old_string")
    new_string = args.get("new_string")
    file_path = args.get("file_path")
    replace_all = bool(args.get("replace_all", False))

    if not isinstance(name, str) or not name.strip():
        return _json({"success": False, "error": "web_skill_patch: missing required 'name'"})
    name = name.strip()
    if not _SKILL_NAME_RE.match(name):
        return _json({"success": False, "error": f"invalid skill name {name!r}"})
    if not isinstance(old_string, str) or not old_string:
        return _json({"success": False, "error": "old_string is required for patch"})
    if new_string is None or not isinstance(new_string, str):
        return _json({
            "success": False,
            "error": "new_string is required for patch (use empty string to delete matched text)",
        })

    skill_dir, forked, err = _ensure_user_skill(name)
    if err or skill_dir is None:
        return _json({"success": False, "error": err or "skill not found"})

    try:
        confine_path(skill_dir)
    except PathSandboxViolation:
        return _json({"success": False, "error": "skill directory resolved outside your workspace"})
    except RuntimeError:
        return _error_no_context()

    if file_path:
        if not isinstance(file_path, str):
            return _json({"success": False, "error": "file_path must be a string"})
        rel = Path(file_path)
        if rel.is_absolute() or ".." in rel.parts:
            return _json({
                "success": False,
                "error": "file_path must be relative and must not contain '..'",
            })
        target = (skill_dir / rel).resolve(strict=False)
        try:
            target.relative_to(skill_dir.resolve(strict=False))
        except ValueError:
            return _json({"success": False, "error": "file_path escapes the skill directory"})
        if not target.is_file():
            return _json({
                "success": False,
                "error": f"file {file_path!r} not found under skill {name!r}",
            })
        rel_label = file_path
    else:
        target = skill_dir / "SKILL.md"
        rel_label = "SKILL.md"

    try:
        original = target.read_text(encoding="utf-8")
    except OSError as exc:
        return _json({"success": False, "error": f"could not read skill file: {exc}"})

    count = original.count(old_string)
    if count == 0:
        return _json({
            "success": False,
            "error": f"old_string not found in {rel_label}",
        })
    if count > 1 and not replace_all:
        return _json({
            "success": False,
            "error": (
                f"old_string matched {count} times in {rel_label}; "
                "pass replace_all=true or provide a more unique old_string"
            ),
        })

    if replace_all:
        updated = original.replace(old_string, new_string)
        replacements = count
    else:
        updated = original.replace(old_string, new_string, 1)
        replacements = 1

    # If patching SKILL.md, re-validate frontmatter + name.
    if rel_label == "SKILL.md":
        ok, meta_or_err = _validate_skill_md(updated, name)
        if not ok:
            return _json({"success": False, "error": meta_or_err})

    updated_bytes = updated.encode("utf-8")
    if len(updated_bytes) > MAX_FILE_BYTES:
        return _json({
            "success": False,
            "error": f"{rel_label} would exceed the {MAX_FILE_BYTES}-byte per-file limit",
        })

    other = sum(
        p.stat().st_size
        for p in skill_dir.rglob("*")
        if p.is_file() and p.resolve(strict=False) != target.resolve(strict=False)
    )
    if other + len(updated_bytes) > MAX_SKILL_BYTES:
        return _json({
            "success": False,
            "error": f"skill total size exceeds the {MAX_SKILL_BYTES}-byte cap",
        })

    target.write_bytes(updated_bytes)
    return _json({
        "success": True,
        "name": name,
        "source": "user",
        "forked": forked,
        "file_path": rel_label,
        "replacements": replacements,
    })


# ── Schemas ────────────────────────────────────────────────────────────


_WEB_SKILLS_LIST_SCHEMA = {
    "name": "web_skills_list",
    "description": (
        "List all skills available to you: global (operator-curated, "
        "read-only) and personal (installed in your workspace via "
        "web_skill_install). Returns name + description + category + "
        "source for each. On name collision the user version overlays "
        "the global. Use web_skill_view(name) for full content."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "category": {
                "type": "string",
                "description": "Optional category filter (e.g. 'research')",
            },
            "source": {
                "type": "string",
                "enum": ["all", "global", "user"],
                "description": "Restrict to global or personal skills (default: all)",
                "default": "all",
            },
        },
        "required": [],
    },
}


_WEB_SKILL_VIEW_SCHEMA = {
    "name": "web_skill_view",
    "description": (
        "Read a skill's SKILL.md or a linked file under it. Personal "
        "skills take precedence over global ones on name collision."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Skill name (must match SKILL.md frontmatter name)",
            },
            "file_path": {
                "type": "string",
                "description": (
                    "Optional relative path under the skill dir, "
                    "e.g. 'references/api.md'. Omit to read SKILL.md."
                ),
            },
        },
        "required": ["name"],
    },
}


_WEB_SKILL_INSTALL_SCHEMA = {
    "name": "web_skill_install",
    "description": (
        "Install a skill into your personal workspace. Creates "
        "skills/<category>/<name>/SKILL.md. Optional side files via "
        "files={'scripts/foo.py': '...', 'references/api.md': '...'}. "
        "Limits: 64KB per file, 256KB total per skill. SKILL.md must "
        "contain valid YAML frontmatter with name (matching install "
        "name), description, and version. Personal skills are NOT "
        "auto-loaded into your system prompt; the agent discovers them "
        "on demand via web_skills_list / web_skill_view."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Skill name — must match ^[A-Za-z0-9_-]{1,64}$",
            },
            "category": {
                "type": "string",
                "description": "Category dir (research, domain, productivity, …)",
            },
            "skill_md": {
                "type": "string",
                "description": "Full SKILL.md content including YAML frontmatter",
            },
            "files": {
                "type": "object",
                "description": "Optional {relpath: content} for scripts/references/assets",
                "additionalProperties": {"type": "string"},
            },
            "overwrite": {
                "type": "boolean",
                "description": "Replace an existing personal skill with the same name",
                "default": False,
            },
        },
        "required": ["name", "category", "skill_md"],
    },
}


_WEB_SKILL_DELETE_SCHEMA = {
    "name": "web_skill_delete",
    "description": (
        "Delete a personal skill from your workspace. Global "
        "operator-curated skills cannot be deleted by users — the call "
        "returns an error if the name resolves only to a global skill."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
        },
        "required": ["name"],
    },
}


_WEB_SKILL_EDIT_SCHEMA = {
    "name": "web_skill_edit",
    "description": (
        "Rewrite a personal skill's SKILL.md (full content). Prefer "
        "web_skill_patch for small habit-driven tweaks. If the skill "
        "exists only in the global catalog, it is forked into the "
        "user workspace first — the global library is never modified."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Skill name — must match SKILL.md frontmatter name",
            },
            "skill_md": {
                "type": "string",
                "description": "Full updated SKILL.md including YAML frontmatter",
            },
        },
        "required": ["name", "skill_md"],
    },
}


_WEB_SKILL_PATCH_SCHEMA = {
    "name": "web_skill_patch",
    "description": (
        "Apply a targeted find-and-replace to a skill file (default "
        "SKILL.md). Preferred way to evolve a skill based on user "
        "habits. Global-only skills are forked into the workspace "
        "before patching. old_string must match exactly once unless "
        "replace_all=true."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "old_string": {
                "type": "string",
                "description": "Exact text to find",
            },
            "new_string": {
                "type": "string",
                "description": "Replacement text (empty string deletes the match)",
            },
            "file_path": {
                "type": "string",
                "description": (
                    "Optional relative path under the skill dir "
                    "(default: SKILL.md)"
                ),
            },
            "replace_all": {
                "type": "boolean",
                "description": "Replace every match of old_string",
                "default": False,
            },
        },
        "required": ["name", "old_string", "new_string"],
    },
}


# ── Platform API helpers (dict results, no JSON string) ────────────────


def create_user_skill(
    name: str,
    skill_md: str,
    *,
    category: str = "productivity",
) -> Dict[str, Any]:
    """Create a brand-new skill under the active user's workspace."""
    ws = get_user_workspace()
    if ws is None:
        return {"success": False, "error": "outside user context"}

    if not _SKILL_NAME_RE.match(name):
        return {"success": False, "error": f"invalid skill name {name!r}"}
    if category not in _ALLOWED_CATEGORIES:
        return {"success": False, "error": f"category {category!r} is not allowed"}

    if _find_skill(name):
        return {"success": False, "error": "skill already exists", "code": "already_installed"}

    ok, meta_or_err = _validate_skill_md(skill_md, expected_name=name)
    if not ok:
        return {"success": False, "error": meta_or_err}

    skill_md_bytes = skill_md.encode("utf-8")
    if len(skill_md_bytes) > MAX_FILE_BYTES:
        return {
            "success": False,
            "error": f"SKILL.md exceeds the {MAX_FILE_BYTES}-byte per-file limit",
        }

    target_dir = ws / "skills" / category / name
    try:
        confined_target = confine_path(target_dir)
    except PathSandboxViolation as exc:
        return {"success": False, "error": f"target dir outside workspace: {exc}"}
    except RuntimeError:
        return {"success": False, "error": "outside user context"}

    confined_target.mkdir(parents=True, exist_ok=True)
    (confined_target / "SKILL.md").write_bytes(skill_md_bytes)
    return {
        "success": True,
        "name": name,
        "category": category,
        "source": "user",
        "bytes_written": len(skill_md_bytes),
    }


def write_user_skill(name: str, skill_md: str) -> Dict[str, Any]:
    """Full SKILL.md rewrite; forks global skills into the workspace."""
    import json as _json

    raw = _handle_web_skill_edit({"name": name, "skill_md": skill_md})
    try:
        return _json.loads(raw)
    except Exception:
        return {"success": False, "error": "internal skill edit failure"}


def delete_user_skill(name: str) -> Dict[str, Any]:
    """Delete a user-owned skill; refuses global skills."""
    import json as _json

    raw = _handle_web_skill_delete({"name": name})
    try:
        return _json.loads(raw)
    except Exception:
        return {"success": False, "error": "internal skill delete failure"}


# ── Registration ───────────────────────────────────────────────────────


_REGISTRATIONS: tuple[tuple[str, Dict[str, Any], Callable], ...] = (
    ("web_skills_list", _WEB_SKILLS_LIST_SCHEMA, _handle_web_skills_list),
    ("web_skill_view", _WEB_SKILL_VIEW_SCHEMA, _handle_web_skill_view),
    ("web_skill_install", _WEB_SKILL_INSTALL_SCHEMA, _handle_web_skill_install),
    ("web_skill_delete", _WEB_SKILL_DELETE_SCHEMA, _handle_web_skill_delete),
    ("web_skill_edit", _WEB_SKILL_EDIT_SCHEMA, _handle_web_skill_edit),
    ("web_skill_patch", _WEB_SKILL_PATCH_SCHEMA, _handle_web_skill_patch),
)


def _register_all() -> None:
    """Idempotent registration — safe if the module is imported twice."""
    for name, schema, handler in _REGISTRATIONS:
        try:
            registry.register(
                name=name,
                toolset=_TOOLSET,
                schema=schema,
                handler=handler,
                max_result_size_chars=100_000,
            )
        except Exception:
            logger.debug("re-registering %s", name, exc_info=True)


_register_all()
