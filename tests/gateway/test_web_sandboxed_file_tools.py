"""Tests for ``gateway.web.tools.sandboxed_file_operations``.

The sandboxed tools wrap ``tools.file_tools`` public functions
(``read_file_tool`` / ``write_file_tool`` / ``patch_tool`` /
``search_tool``) and prefix each call with a
``confine_path(path)`` check.  Tests verify three contracts:

1. In-workspace paths are confined and the resolved absolute path
   is forwarded to the upstream tool unchanged in semantics.
2. Out-of-workspace paths (``../``, absolute outside, sibling user
   workspaces) are rejected with a JSON error before reaching the
   upstream tool.
3. Defensive: tools invoked outside an active user context return
   an internal-error JSON, not a Python traceback.

Upstream ``*_tool`` functions are mocked so the suite doesn't need
the full hermes test rig (lint, file_state, ripgrep, etc.).  The
real call path is exercised by the stage-8 integration test.
"""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from gateway.web import sandbox
from gateway.web.sandbox import enter_user_context


# ── Fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture
def hermes_home(tmp_path, monkeypatch):
    home = tmp_path / "hermes_home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home


@pytest.fixture
def alice_workspace(hermes_home):
    """Enter a user context for u_alice for the duration of the test."""
    with enter_user_context("u_alice") as ws:
        yield ws


def _call(handler_name, args):
    """Convenience to import and call a sandboxed handler by name."""
    from gateway.web.tools import sandboxed_file_operations as mod
    handler = getattr(mod, f"_handle_{handler_name}")
    return handler(args)


def _is_error_json(result: str) -> bool:
    """A rejection comes back as a JSON-encoded dict with success=False."""
    try:
        decoded = json.loads(result)
    except (json.JSONDecodeError, TypeError):
        return False
    return isinstance(decoded, dict) and decoded.get("success") is False


# ── web_file_read ──────────────────────────────────────────────────────────


def test_read_inside_workspace_calls_upstream(alice_workspace):
    target = alice_workspace / "files" / "doc.txt"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("hello", encoding="utf-8")

    with patch("gateway.web.tools.sandboxed_file_operations.read_file_tool") as mocked:
        mocked.return_value = "1|hello"
        result = _call("web_file_read", {"path": str(target), "offset": 1, "limit": 10})

    assert result == "1|hello"
    # Confined path is absolute, resolved, and inside the workspace.
    sent_path = mocked.call_args.kwargs["path"]
    assert str(alice_workspace) in sent_path
    assert mocked.call_args.kwargs["offset"] == 1
    assert mocked.call_args.kwargs["limit"] == 10


def test_read_rejects_dotdot_escape(alice_workspace):
    with patch("gateway.web.tools.sandboxed_file_operations.read_file_tool") as mocked:
        result = _call("web_file_read", {"path": str(alice_workspace / ".." / "u_bob" / "MEMORY.md")})
    assert _is_error_json(result)
    assert "outside your workspace" in result
    mocked.assert_not_called()


def test_read_rejects_absolute_outside(alice_workspace):
    with patch("gateway.web.tools.sandboxed_file_operations.read_file_tool") as mocked:
        result = _call("web_file_read", {"path": "/etc/passwd"})
    assert _is_error_json(result)
    mocked.assert_not_called()


def test_read_rejects_sibling_user_workspace(hermes_home, alice_workspace):
    bob_ws = hermes_home / "web_workspaces" / "u_bob"
    bob_ws.mkdir(parents=True, exist_ok=True)
    (bob_ws / "memories").mkdir(exist_ok=True)
    (bob_ws / "memories" / "MEMORY.md").write_text("bob secret", encoding="utf-8")

    with patch("gateway.web.tools.sandboxed_file_operations.read_file_tool") as mocked:
        result = _call("web_file_read", {"path": str(bob_ws / "memories" / "MEMORY.md")})
    assert _is_error_json(result)
    mocked.assert_not_called()


def test_read_outside_user_context_returns_internal_error(hermes_home):
    """No enter_user_context active → tool returns JSON error, not crash."""
    with patch("gateway.web.tools.sandboxed_file_operations.read_file_tool") as mocked:
        result = _call("web_file_read", {"path": "/etc/passwd"})
    assert _is_error_json(result)
    assert "internal sandbox not initialised" in result
    mocked.assert_not_called()


# ── web_file_write ─────────────────────────────────────────────────────────


def test_write_inside_workspace_calls_upstream(alice_workspace):
    target = alice_workspace / "files" / "out.txt"
    with patch("gateway.web.tools.sandboxed_file_operations.write_file_tool") as mocked:
        mocked.return_value = "ok"
        result = _call("web_file_write", {"path": str(target), "content": "data"})
    assert result == "ok"
    assert mocked.call_args.kwargs["content"] == "data"
    sent_path = mocked.call_args.kwargs["path"]
    assert str(alice_workspace) in sent_path


def test_write_rejects_escape(alice_workspace):
    with patch("gateway.web.tools.sandboxed_file_operations.write_file_tool") as mocked:
        result = _call("web_file_write", {
            "path": str(alice_workspace / ".." / "u_bob" / "MEMORY.md"),
            "content": "pwn",
        })
    assert _is_error_json(result)
    mocked.assert_not_called()


def test_write_rejects_missing_path(alice_workspace):
    with patch("gateway.web.tools.sandboxed_file_operations.write_file_tool") as mocked:
        result = _call("web_file_write", {"content": "data"})
    assert _is_error_json(result)
    mocked.assert_not_called()


def test_write_rejects_non_string_content(alice_workspace):
    with patch("gateway.web.tools.sandboxed_file_operations.write_file_tool") as mocked:
        result = _call("web_file_write", {
            "path": str(alice_workspace / "files" / "out.txt"),
            "content": 42,
        })
    assert _is_error_json(result)
    mocked.assert_not_called()


# ── web_file_patch ─────────────────────────────────────────────────────────


def test_patch_replace_inside_workspace_calls_upstream(alice_workspace):
    target = alice_workspace / "files" / "doc.txt"
    with patch("gateway.web.tools.sandboxed_file_operations.patch_tool") as mocked:
        mocked.return_value = "ok"
        result = _call("web_file_patch", {
            "mode": "replace",
            "path": str(target),
            "old_string": "foo",
            "new_string": "bar",
        })
    assert result == "ok"
    assert mocked.call_args.kwargs["old_string"] == "foo"
    assert mocked.call_args.kwargs["new_string"] == "bar"


def test_patch_replace_rejects_escape(alice_workspace):
    with patch("gateway.web.tools.sandboxed_file_operations.patch_tool") as mocked:
        result = _call("web_file_patch", {
            "mode": "replace",
            "path": "/etc/passwd",
            "old_string": "root",
            "new_string": "pwned",
        })
    assert _is_error_json(result)
    mocked.assert_not_called()


def test_patch_v4a_mode_rejected_in_sandbox(alice_workspace):
    """V4A 'patch' mode embeds filenames inside the patch payload —
    confine_path can't inspect those, so the sandbox forbids it.
    """
    with patch("gateway.web.tools.sandboxed_file_operations.patch_tool") as mocked:
        result = _call("web_file_patch", {
            "mode": "patch",
            "patch": "*** Begin Patch\n*** Update File: /etc/shadow\n+ pwn\n*** End Patch",
        })
    assert _is_error_json(result)
    assert "V4A" in result or "patch" in result.lower()
    mocked.assert_not_called()


def test_patch_unknown_mode_rejected(alice_workspace):
    with patch("gateway.web.tools.sandboxed_file_operations.patch_tool") as mocked:
        result = _call("web_file_patch", {"mode": "nuke"})
    assert _is_error_json(result)
    mocked.assert_not_called()


def test_patch_missing_path_rejected(alice_workspace):
    with patch("gateway.web.tools.sandboxed_file_operations.patch_tool") as mocked:
        result = _call("web_file_patch", {
            "mode": "replace",
            "old_string": "a",
            "new_string": "b",
        })
    assert _is_error_json(result)
    mocked.assert_not_called()


# ── web_file_search ────────────────────────────────────────────────────────


def test_search_dot_resolves_to_workspace_root(alice_workspace):
    with patch("gateway.web.tools.sandboxed_file_operations.search_tool") as mocked:
        mocked.return_value = "hit"
        result = _call("web_file_search", {"pattern": "foo", "path": "."})
    assert result == "hit"
    assert mocked.call_args.kwargs["path"] == str(alice_workspace)


def test_search_explicit_path_inside_workspace(alice_workspace):
    subdir = alice_workspace / "files"
    subdir.mkdir(exist_ok=True)
    with patch("gateway.web.tools.sandboxed_file_operations.search_tool") as mocked:
        mocked.return_value = "hit"
        _call("web_file_search", {"pattern": "foo", "path": str(subdir)})
    assert str(alice_workspace) in mocked.call_args.kwargs["path"]


def test_search_rejects_path_outside_workspace(alice_workspace):
    with patch("gateway.web.tools.sandboxed_file_operations.search_tool") as mocked:
        result = _call("web_file_search", {"pattern": "foo", "path": "/etc"})
    assert _is_error_json(result)
    mocked.assert_not_called()


def test_search_target_alias_grep_to_content(alice_workspace):
    """`target='grep'` is mapped to 'content' to match upstream's
    historic compatibility layer."""
    with patch("gateway.web.tools.sandboxed_file_operations.search_tool") as mocked:
        mocked.return_value = "hit"
        _call("web_file_search", {"pattern": "foo", "target": "grep", "path": "."})
    assert mocked.call_args.kwargs["target"] == "content"


def test_search_target_alias_find_to_files(alice_workspace):
    with patch("gateway.web.tools.sandboxed_file_operations.search_tool") as mocked:
        mocked.return_value = "hit"
        _call("web_file_search", {"pattern": "*.py", "target": "find", "path": "."})
    assert mocked.call_args.kwargs["target"] == "files"


# ── Cross-user isolation under concurrent contexts ─────────────────────────


def test_alice_cannot_read_bob_through_resolved_path(hermes_home):
    """Even if Alice constructs an absolute path that points into
    Bob's workspace, confine_path catches it because Alice's active
    workspace is u_alice, not u_bob."""
    sandbox.ensure_workspace("u_bob")
    bob_secret = hermes_home / "web_workspaces" / "u_bob" / "memories" / "MEMORY.md"
    bob_secret.write_text("bob's secret", encoding="utf-8")

    with enter_user_context("u_alice"):
        with patch("gateway.web.tools.sandboxed_file_operations.read_file_tool") as mocked:
            result = _call("web_file_read", {"path": str(bob_secret)})
        assert _is_error_json(result)
        mocked.assert_not_called()


def test_alice_can_read_her_own_file(alice_workspace):
    """Sanity check the positive path — the confine doesn't block
    legitimate workspace-internal access."""
    target = alice_workspace / "files" / "doc.txt"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("alice's note", encoding="utf-8")

    with patch("gateway.web.tools.sandboxed_file_operations.read_file_tool") as mocked:
        mocked.return_value = "1|alice's note"
        result = _call("web_file_read", {"path": str(target)})
    assert result == "1|alice's note"
