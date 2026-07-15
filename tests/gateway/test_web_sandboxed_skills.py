"""Tests for ``gateway.web.tools.sandboxed_skill_manage``.

Covers the 18 cases enumerated in §7 of
``docs/plans/2026-05-26-per-user-skill-isolation.md`` plus a handful of
extra contracts the design left implicit (``overwrite=true`` replaces,
``files{}`` can't smuggle in a SKILL.md, bad-category rejection).

The handlers are exercised directly with real I/O under ``tmp_path`` —
no mocking. The global skills layer is seeded by writing SKILL.md files
under the tmp ``HERMES_HOME``; the user layer is populated through the
``web_skill_install`` handler itself. This gives us end-to-end coverage
of the (scan → merge → overlay) discovery pipeline.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from gateway.web.sandbox import enter_user_context
from gateway.web.tools import sandboxed_skill_manage as mod


# ── Fixtures ────────────────────────────────────────────────────────────


@pytest.fixture
def hermes_home(tmp_path, monkeypatch):
    home = tmp_path / "hermes_home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home


@pytest.fixture
def alice_workspace(hermes_home):
    """Enter a user context for u_alice for the test body."""
    with enter_user_context("u_alice") as ws:
        yield ws


def _seed_global_skill(
    home: Path,
    category: str,
    name: str,
    desc: str = "global skill",
    *,
    content: str | None = None,
) -> Path:
    """Plant a SKILL.md under the tmp global library."""
    skill_dir = home / "skills" / category / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    if content is None:
        content = (
            f"---\n"
            f"name: {name}\n"
            f'description: "{desc}"\n'
            f"version: 1.0.0\n"
            f"---\n"
            f"# {name}\n"
        )
    (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")
    return skill_dir


def _good_skill_md(name: str, desc: str = "a personal skill") -> str:
    return (
        f"---\n"
        f"name: {name}\n"
        f'description: "{desc}"\n'
        f"version: 1.0.0\n"
        f"---\n"
        f"# {name}\n\nBody.\n"
    )


def test_web_skills_list_hides_apple_macos_only(hermes_home, alice_workspace):
    """Apple / macOS-only catalog skills must not surface to the agent."""
    _seed_global_skill(
        hermes_home,
        "apple",
        "imessage",
        content=(
            "---\n"
            "name: imessage\n"
            'description: "Send iMessage"\n'
            "platforms: [macos]\n"
            "version: 1.0.0\n"
            "---\n"
            "# imessage\n"
        ),
    )
    _seed_global_skill(hermes_home, "research", "arxiv", desc="arxiv search")

    result = _call("web_skills_list", {})
    assert result["success"] is True
    names = {s["name"] for s in result["skills"]}
    assert "arxiv" in names
    assert "imessage" not in names


def test_web_skill_view_rejects_apple_skill(hermes_home, alice_workspace):
    _seed_global_skill(
        hermes_home,
        "apple",
        "apple-notes",
        content=(
            "---\n"
            "name: apple-notes\n"
            'description: "Notes"\n'
            "platforms: [macos]\n"
            "version: 1.0.0\n"
            "---\n"
            "# apple-notes\n"
        ),
    )
    result = _call("web_skill_view", {"name": "apple-notes"})
    assert result["success"] is False


def test_install_from_catalog_rejects_apple(hermes_home, alice_workspace):
    _seed_global_skill(
        hermes_home,
        "apple",
        "findmy",
        content=(
            "---\n"
            "name: findmy\n"
            'description: "Find My"\n'
            "platforms: [macos]\n"
            "version: 1.0.0\n"
            "---\n"
            "# findmy\n"
        ),
    )
    result = mod.install_skill_from_catalog("findmy")
    assert result["success"] is False
    assert result.get("code") in ("not_found", "web_excluded")


def _call(handler_name: str, args: dict) -> dict:
    handler = getattr(mod, f"_handle_{handler_name}")
    return json.loads(handler(args))


# ── web_skills_list ────────────────────────────────────────────────────


def test_list_empty_user_workspace_shows_globals(hermes_home, alice_workspace):
    _seed_global_skill(hermes_home, "research", "arxiv", "arxiv search")
    _seed_global_skill(hermes_home, "domain", "biology", "biology stuff")

    result = _call("web_skills_list", {})

    assert result["success"] is True
    names_sources = {(s["name"], s["source"]) for s in result["skills"]}
    assert ("arxiv", "global") in names_sources
    assert ("biology", "global") in names_sources


def test_list_user_overlays_global(hermes_home, alice_workspace):
    _seed_global_skill(hermes_home, "research", "arxiv", "global version")
    _call("web_skill_install", {
        "name": "arxiv",
        "category": "research",
        "skill_md": _good_skill_md("arxiv", "user version"),
    })

    result = _call("web_skills_list", {})

    arxiv_entries = [s for s in result["skills"] if s["name"] == "arxiv"]
    assert len(arxiv_entries) == 1, "user version should hide global version"
    assert arxiv_entries[0]["source"] == "user"
    assert arxiv_entries[0]["description"] == "user version"


def test_list_category_filter(hermes_home, alice_workspace):
    _seed_global_skill(hermes_home, "research", "arxiv")
    _seed_global_skill(hermes_home, "domain", "biology")

    result = _call("web_skills_list", {"category": "research"})

    assert {s["category"] for s in result["skills"]} == {"research"}


def test_list_source_filter_user_excludes_globals(hermes_home, alice_workspace):
    _seed_global_skill(hermes_home, "research", "arxiv")
    _call("web_skill_install", {
        "name": "mine",
        "category": "research",
        "skill_md": _good_skill_md("mine"),
    })

    result = _call("web_skills_list", {"source": "user"})

    assert {s["source"] for s in result["skills"]} == {"user"}
    assert all(s["name"] != "arxiv" for s in result["skills"])


def test_list_source_filter_global_excludes_user(hermes_home, alice_workspace):
    _seed_global_skill(hermes_home, "research", "arxiv")
    _call("web_skill_install", {
        "name": "mine",
        "category": "research",
        "skill_md": _good_skill_md("mine"),
    })

    result = _call("web_skills_list", {"source": "global"})

    assert {s["source"] for s in result["skills"]} == {"global"}


def test_list_invalid_source_rejected(hermes_home, alice_workspace):
    result = _call("web_skills_list", {"source": "nonsense"})
    assert result["success"] is False
    assert "invalid source" in result["error"]


# ── web_skill_view ─────────────────────────────────────────────────────


def test_view_personal_skill(hermes_home, alice_workspace):
    md = _good_skill_md("mine", "my note")
    _call("web_skill_install", {
        "name": "mine",
        "category": "research",
        "skill_md": md,
    })

    result = _call("web_skill_view", {"name": "mine"})

    assert result["success"] is True
    assert result["source"] == "user"
    assert result["content"] == md


def test_view_global_fallback(hermes_home, alice_workspace):
    _seed_global_skill(hermes_home, "research", "arxiv", "global description")

    result = _call("web_skill_view", {"name": "arxiv"})

    assert result["success"] is True
    assert result["source"] == "global"
    assert "arxiv" in result["content"]


def test_view_not_found(hermes_home, alice_workspace):
    result = _call("web_skill_view", {"name": "nonexistent"})
    assert result["success"] is False
    assert "not found" in result["error"]


def test_view_file_path(hermes_home, alice_workspace):
    _call("web_skill_install", {
        "name": "mine",
        "category": "research",
        "skill_md": _good_skill_md("mine"),
        "files": {"references/api.md": "# API\n"},
    })

    result = _call("web_skill_view", {"name": "mine", "file_path": "references/api.md"})

    assert result["success"] is True
    assert result["content"] == "# API\n"
    assert result["file_path"] == "references/api.md"


def test_view_file_path_escape_rejected(hermes_home, alice_workspace):
    _call("web_skill_install", {
        "name": "mine",
        "category": "research",
        "skill_md": _good_skill_md("mine"),
    })

    result = _call("web_skill_view", {"name": "mine", "file_path": "../../escape.md"})
    assert result["success"] is False


def test_view_invalid_name_rejected(hermes_home, alice_workspace):
    result = _call("web_skill_view", {"name": "../etc"})
    assert result["success"] is False


# ── web_skill_install ──────────────────────────────────────────────────


def test_install_happy_path(hermes_home, alice_workspace):
    result = _call("web_skill_install", {
        "name": "mine",
        "category": "research",
        "skill_md": _good_skill_md("mine"),
        "files": {"references/foo.md": "foo content"},
    })

    assert result["success"] is True
    assert result["files"] == 2
    assert result["source"] == "user"
    on_disk = alice_workspace / "skills" / "research" / "mine"
    assert (on_disk / "SKILL.md").exists()
    assert (on_disk / "references" / "foo.md").read_text() == "foo content"


@pytest.mark.parametrize(
    "bad_name",
    ["../escape", "with space", "a" * 65, "weird/name", "", "name.with.dots"],
)
def test_install_bad_name_rejected(hermes_home, alice_workspace, bad_name):
    result = _call("web_skill_install", {
        "name": bad_name,
        "category": "research",
        "skill_md": _good_skill_md(bad_name),
    })
    assert result["success"] is False


def test_install_bad_category_rejected(hermes_home, alice_workspace):
    result = _call("web_skill_install", {
        "name": "mine",
        "category": "totally-fake-category",
        "skill_md": _good_skill_md("mine"),
    })
    assert result["success"] is False
    assert "allowed_categories" in result


def test_install_frontmatter_name_mismatch(hermes_home, alice_workspace):
    result = _call("web_skill_install", {
        "name": "mine",
        "category": "research",
        "skill_md": _good_skill_md("imposter"),
    })
    assert result["success"] is False
    assert "does not match" in result["error"]


def test_install_missing_frontmatter(hermes_home, alice_workspace):
    result = _call("web_skill_install", {
        "name": "mine",
        "category": "research",
        "skill_md": "# Just a markdown file with no frontmatter.\n",
    })
    assert result["success"] is False


def test_install_missing_description(hermes_home, alice_workspace):
    md = "---\nname: mine\nversion: 1.0.0\n---\n# body\n"
    result = _call("web_skill_install", {
        "name": "mine",
        "category": "research",
        "skill_md": md,
    })
    assert result["success"] is False
    assert "description" in result["error"]


def test_install_file_size_cap(hermes_home, alice_workspace):
    huge = "x" * (mod.MAX_FILE_BYTES + 1)
    result = _call("web_skill_install", {
        "name": "mine",
        "category": "research",
        "skill_md": _good_skill_md("mine"),
        "files": {"references/big.md": huge},
    })
    assert result["success"] is False
    assert "per-file" in result["error"]


def test_install_total_size_cap(hermes_home, alice_workspace):
    # Five chunks just under the per-file cap easily sum past the per-skill cap.
    chunk = "x" * (mod.MAX_FILE_BYTES - 100)
    files = {f"references/f{i}.md": chunk for i in range(5)}
    result = _call("web_skill_install", {
        "name": "mine",
        "category": "research",
        "skill_md": _good_skill_md("mine"),
        "files": files,
    })
    assert result["success"] is False
    assert "total" in result["error"]


def test_install_overwrite_false_refuses(hermes_home, alice_workspace):
    _call("web_skill_install", {
        "name": "mine",
        "category": "research",
        "skill_md": _good_skill_md("mine"),
    })
    result = _call("web_skill_install", {
        "name": "mine",
        "category": "research",
        "skill_md": _good_skill_md("mine"),
    })
    assert result["success"] is False
    assert "already exists" in result["error"]


def test_install_overwrite_true_replaces(hermes_home, alice_workspace):
    _call("web_skill_install", {
        "name": "mine",
        "category": "research",
        "skill_md": _good_skill_md("mine", "v1"),
    })

    result = _call("web_skill_install", {
        "name": "mine",
        "category": "research",
        "skill_md": _good_skill_md("mine", "v2"),
        "overwrite": True,
    })

    assert result["success"] is True
    view = _call("web_skill_view", {"name": "mine"})
    assert "v2" in view["content"]


def test_install_files_cannot_smuggle_skill_md(hermes_home, alice_workspace):
    result = _call("web_skill_install", {
        "name": "mine",
        "category": "research",
        "skill_md": _good_skill_md("mine"),
        "files": {"SKILL.md": "tampered content"},
    })
    assert result["success"] is False
    assert "SKILL.md" in result["error"]


def test_install_files_relpath_escape_rejected(hermes_home, alice_workspace):
    result = _call("web_skill_install", {
        "name": "mine",
        "category": "research",
        "skill_md": _good_skill_md("mine"),
        "files": {"../escape.md": "pwn"},
    })
    assert result["success"] is False


# ── Cross-tenant isolation ─────────────────────────────────────────────


def test_install_never_writes_to_global_tree(hermes_home, alice_workspace):
    """Direct security-property guard: ``web_skill_install`` must write into
    the user's workspace, never into the operator-curated global library.

    Even a successful install must leave ``$HERMES_HOME/skills/<cat>/<name>``
    absent.  This is the property the user pinned the design on: web installs
    are isolated, not global.
    """
    result = _call("web_skill_install", {
        "name": "alice-private",
        "category": "research",
        "skill_md": _good_skill_md("alice-private"),
    })
    assert result["success"] is True
    # User-side: present
    assert (alice_workspace / "skills" / "research" / "alice-private" / "SKILL.md").exists()
    # Global-side: must not be touched at all
    assert not (hermes_home / "skills" / "research" / "alice-private").exists()


def test_install_invisible_to_other_user(hermes_home):
    with enter_user_context("u_alice"):
        _call("web_skill_install", {
            "name": "alice-only",
            "category": "domain",
            "skill_md": _good_skill_md("alice-only", "alice's"),
        })

    with enter_user_context("u_bob"):
        listing = _call("web_skills_list", {})
        assert all(s["name"] != "alice-only" for s in listing["skills"])
        view = _call("web_skill_view", {"name": "alice-only"})
        assert view["success"] is False


# ── web_skill_delete ───────────────────────────────────────────────────


def test_delete_personal_skill(hermes_home, alice_workspace):
    _call("web_skill_install", {
        "name": "mine",
        "category": "research",
        "skill_md": _good_skill_md("mine"),
        "files": {"references/api.md": "x" * 100},
    })

    result = _call("web_skill_delete", {"name": "mine"})

    assert result["success"] is True
    assert result["deleted_bytes"] > 0
    assert not (alice_workspace / "skills" / "research" / "mine").exists()


def test_delete_global_rejected(hermes_home, alice_workspace):
    _seed_global_skill(hermes_home, "research", "arxiv")

    result = _call("web_skill_delete", {"name": "arxiv"})

    assert result["success"] is False
    assert "read-only" in result["error"]
    # And the on-disk file is untouched.
    assert (hermes_home / "skills" / "research" / "arxiv" / "SKILL.md").exists()


def test_delete_nonexistent(hermes_home, alice_workspace):
    result = _call("web_skill_delete", {"name": "ghost"})
    assert result["success"] is False
    assert "not found" in result["error"]


def test_delete_invalid_name(hermes_home, alice_workspace):
    result = _call("web_skill_delete", {"name": "../etc"})
    assert result["success"] is False


# ── web_skill_edit / web_skill_patch ───────────────────────────────────


def test_edit_personal_skill(hermes_home, alice_workspace):
    _call("web_skill_install", {
        "name": "mine",
        "category": "research",
        "skill_md": _good_skill_md("mine", "v1"),
    })
    updated = _good_skill_md("mine", "evolved habit")

    result = _call("web_skill_edit", {"name": "mine", "skill_md": updated})

    assert result["success"] is True
    assert result["source"] == "user"
    view = _call("web_skill_view", {"name": "mine"})
    assert "evolved habit" in view["content"]


def test_edit_global_forks_into_workspace(hermes_home, alice_workspace):
    _seed_global_skill(hermes_home, "research", "arxiv", "global version")
    updated = _good_skill_md("arxiv", "my fork")

    result = _call("web_skill_edit", {"name": "arxiv", "skill_md": updated})

    assert result["success"] is True
    assert result["forked"] is True
    assert result["source"] == "user"
    # Global library stays untouched.
    global_md = (hermes_home / "skills" / "research" / "arxiv" / "SKILL.md").read_text()
    assert "global version" in global_md
    user_view = _call("web_skill_view", {"name": "arxiv"})
    assert user_view["source"] == "user"
    assert "my fork" in user_view["content"]


def test_patch_personal_skill(hermes_home, alice_workspace):
    md = _good_skill_md("mine") + "\nUse tool A always.\n"
    _call("web_skill_install", {
        "name": "mine",
        "category": "research",
        "skill_md": md,
    })

    result = _call("web_skill_patch", {
        "name": "mine",
        "old_string": "Use tool A always.",
        "new_string": "Prefer tool B for this workflow.",
    })

    assert result["success"] is True
    view = _call("web_skill_view", {"name": "mine"})
    assert "Prefer tool B" in view["content"]
    assert "Use tool A always." not in view["content"]


def test_patch_global_forks_then_patches(hermes_home, alice_workspace):
    content = (
        "---\nname: arxiv\ndescription: \"global skill\"\nversion: 1.0.0\n---\n"
        "# arxiv\n\nSearch arxiv first.\n"
    )
    _seed_global_skill(hermes_home, "research", "arxiv", content=content)

    result = _call("web_skill_patch", {
        "name": "arxiv",
        "old_string": "Search arxiv first.",
        "new_string": "Search arxiv, then summarise abstract.",
    })

    assert result["success"] is True
    assert result["forked"] is True
    view = _call("web_skill_view", {"name": "arxiv"})
    assert view["source"] == "user"
    assert "summarise abstract" in view["content"]


def test_patch_unique_match_required(hermes_home, alice_workspace):
    md = _good_skill_md("mine") + "\nfoo\nfoo\n"
    _call("web_skill_install", {
        "name": "mine",
        "category": "research",
        "skill_md": md,
    })

    result = _call("web_skill_patch", {
        "name": "mine",
        "old_string": "foo",
        "new_string": "bar",
    })
    assert result["success"] is False
    assert "unique" in result["error"].lower() or "multiple" in result["error"].lower()


# ── Outside-context safety ─────────────────────────────────────────────


@pytest.mark.parametrize(
    "handler_name,args",
    [
        ("web_skills_list", {}),
        ("web_skill_view", {"name": "x"}),
        (
            "web_skill_install",
            {
                "name": "x",
                "category": "research",
                "skill_md": _good_skill_md("x"),
            },
        ),
        ("web_skill_delete", {"name": "x"}),
        ("web_skill_edit", {"name": "x", "skill_md": _good_skill_md("x")}),
        (
            "web_skill_patch",
            {"name": "x", "old_string": "a", "new_string": "b"},
        ),
    ],
)
def test_handler_outside_user_context_returns_internal_error(hermes_home, handler_name, args):
    """Every handler must refuse cleanly when no user context is active."""
    result = _call(handler_name, args)
    assert result["success"] is False
    assert "internal sandbox not initialised" in result["error"]
