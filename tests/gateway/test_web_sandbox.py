"""Tests for ``gateway.web.sandbox`` — per-user filesystem + HERMES_HOME
isolation.

Covers the contract:

- ``enter_user_context(user_id)`` binds both the workspace contextvar
  and ``HERMES_HOME`` override for the duration of the block.
- Concurrent asyncio tasks see independent contextvars (per-task copies).
- ``confine_path`` accepts paths inside the workspace and rejects paths
  outside, including ``../`` escapes and absolute paths.
- ``confine_path`` raises ``RuntimeError`` (not ``PathSandboxViolation``)
  when called outside a user context, so silent fallback never happens.
"""

import asyncio
from pathlib import Path

import pytest

from gateway.web import sandbox
from gateway.web.sandbox import (
    PathSandboxViolation,
    confine_path,
    enter_user_context,
    ensure_workspace,
    get_user_workspace,
    workspaces_root,
)
from hermes_constants import get_hermes_home


@pytest.fixture
def hermes_home(tmp_path, monkeypatch):
    """Redirect HERMES_HOME to a temp dir for the test."""
    home = tmp_path / "hermes_home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home


# ── ensure_workspace / workspace_for ───────────────────────────────────────


def test_ensure_workspace_creates_canonical_subdirs(hermes_home):
    ws = ensure_workspace("u_alice")
    assert ws == hermes_home / "web_workspaces" / "u_alice"
    assert (ws / "memories").is_dir()
    assert (ws / "files").is_dir()
    assert (ws / "cache").is_dir()


def test_workspaces_root_is_under_hermes_home(hermes_home):
    assert workspaces_root() == hermes_home / "web_workspaces"


def test_ensure_workspace_is_idempotent(hermes_home):
    ws1 = ensure_workspace("u_alice")
    ws2 = ensure_workspace("u_alice")
    assert ws1 == ws2
    # Subdir contents preserved
    (ws1 / "memories" / "MEMORY.md").write_text("alice notes", encoding="utf-8")
    ensure_workspace("u_alice")
    assert (ws1 / "memories" / "MEMORY.md").read_text(encoding="utf-8") == "alice notes"


# ── enter_user_context contextvar lifecycle ────────────────────────────────


def test_enter_user_context_sets_both_contextvars(hermes_home):
    assert get_user_workspace() is None  # default state
    with enter_user_context("u_alice") as ws:
        assert get_user_workspace() == ws
        # HERMES_HOME override actively redirects get_hermes_home()
        assert get_hermes_home() == ws
    # Both reset on exit
    assert get_user_workspace() is None
    assert get_hermes_home() == hermes_home


def test_enter_user_context_sets_terminal_cwd_override(hermes_home):
    """Web chat must not discover context files from the process CWD
    (the hermes-agent checkout). Bind TERMINAL_CWD to the user workspace.
    """
    from hermes_constants import get_terminal_cwd

    assert get_terminal_cwd() is None
    with enter_user_context("u_alice") as ws:
        assert get_terminal_cwd() == str(ws)
    assert get_terminal_cwd() is None


def test_ensure_workspace_includes_uploads(hermes_home):
    ws = ensure_workspace("u_alice")
    assert (ws / "uploads").is_dir()
    assert (ws / "skills").is_dir()


def test_enter_user_context_is_reentrant(hermes_home):
    """Nested entry (e.g. spawn subagent for a different user) works
    correctly — outer context restored on inner exit.

    This is a corner case but matters because the agent loop can spawn
    delegate subagents.  ContextVar Token-based reset handles it.
    """
    with enter_user_context("u_alice") as alice_ws:
        with enter_user_context("u_bob") as bob_ws:
            assert get_user_workspace() == bob_ws
            assert get_hermes_home() == bob_ws
        # Back to Alice
        assert get_user_workspace() == alice_ws
        assert get_hermes_home() == alice_ws


def test_enter_user_context_resets_on_exception(hermes_home):
    with pytest.raises(RuntimeError, match="oops"):
        with enter_user_context("u_alice"):
            raise RuntimeError("oops")
    assert get_user_workspace() is None
    assert get_hermes_home() == hermes_home


# ── confine_path ───────────────────────────────────────────────────────────


def test_confine_path_accepts_paths_inside_workspace(hermes_home):
    with enter_user_context("u_alice") as ws:
        resolved = confine_path(ws / "files" / "doc.txt")
        assert resolved == (ws / "files" / "doc.txt").resolve()


def test_confine_path_accepts_relative_paths_inside(hermes_home):
    with enter_user_context("u_alice") as ws:
        # Relative inputs resolve against the *workspace*, not os.getcwd —
        # the tool schemas advertise "relative to workspace" and the
        # attachment convention (``uploads/<name>``) relies on it.
        resolved = confine_path("uploads/data.csv")
        assert resolved == (ws / "uploads" / "data.csv").resolve()
        # Absolute paths under the workspace still pass through unchanged.
        resolved_abs = confine_path(ws / "files/nested/doc.txt")
        assert resolved_abs == (ws / "files" / "nested" / "doc.txt").resolve()


def test_confine_path_rejects_relative_dotdot_escape(hermes_home):
    with enter_user_context("u_alice"):
        # A relative ``..`` escape resolves against the workspace and must
        # still be rejected once it climbs out of it.
        with pytest.raises(PathSandboxViolation):
            confine_path("../u_bob/MEMORY.md")


def test_confine_path_rejects_dotdot_escape(hermes_home):
    with enter_user_context("u_alice") as ws:
        with pytest.raises(PathSandboxViolation):
            confine_path(ws / ".." / "u_bob" / "MEMORY.md")


def test_confine_path_rejects_absolute_outside(hermes_home):
    with enter_user_context("u_alice"):
        with pytest.raises(PathSandboxViolation):
            confine_path("/etc/passwd")


def test_confine_path_rejects_sibling_workspace(hermes_home):
    ensure_workspace("u_bob")
    with enter_user_context("u_alice"):
        with pytest.raises(PathSandboxViolation):
            confine_path(hermes_home / "web_workspaces" / "u_bob" / "memories" / "MEMORY.md")


def test_confine_path_outside_user_context_raises_runtime_error(hermes_home):
    """Safety property: confine_path never silently passes when no user
    context is active.  A sandboxed tool calling it outside enter_user_context
    is always a programming error, not a user-input issue."""
    with pytest.raises(RuntimeError, match="outside a web user context"):
        confine_path("/tmp/foo")


def test_confine_path_handles_non_existent_targets(hermes_home):
    """Writes need to confine the destination before it exists."""
    with enter_user_context("u_alice") as ws:
        new_file = ws / "files" / "does_not_exist_yet.txt"
        # Should not raise — just resolves and confines.
        resolved = confine_path(new_file)
        assert resolved == new_file.resolve()


# ── Cross-task isolation (asyncio ContextVar semantics) ───────────────────


@pytest.mark.asyncio
async def test_concurrent_asyncio_tasks_have_independent_contexts(hermes_home):
    """ContextVar copies on task creation — tasks for different users
    must see their own workspace, never each other's.
    """
    barrier = asyncio.Event()
    seen = {}

    async def user_task(user_id: str):
        with enter_user_context(user_id) as ws:
            seen[user_id] = ws
            # Yield so the other task can run with its own context.
            barrier.set()
            await asyncio.sleep(0.01)
            # Re-check after the yield: still our own workspace.
            assert get_user_workspace() == ws
            assert get_hermes_home() == ws

    await asyncio.gather(
        user_task("u_alice"),
        user_task("u_bob"),
    )
    assert seen["u_alice"] != seen["u_bob"]
    assert seen["u_alice"].name == "u_alice"
    assert seen["u_bob"].name == "u_bob"
    # Parent task sees neither workspace.
    assert get_user_workspace() is None


@pytest.mark.asyncio
async def test_concurrent_requests_dont_swap_user_contexts(hermes_home):
    """UUID-style user ids must not swap ContextVars under concurrent load.

    Named to match the TODOLIST / test-first checklist contract. Same
    ContextVar semantics as the ``u_*`` case above, but with platform
    register-shaped identifiers.
    """
    del hermes_home  # fixture only redirects HERMES_HOME
    alice = "550e8400-e29b-41d4-a716-446655440000"
    bob = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
    barrier = asyncio.Barrier(2)
    seen: dict[str, Path] = {}

    async def user_task(user_id: str) -> None:
        with enter_user_context(user_id) as ws:
            seen[user_id] = ws
            await barrier.wait()
            # Peer has entered its own context; ours must be unchanged.
            assert get_user_workspace() == ws
            assert get_hermes_home() == ws
            assert ws.name == user_id

    await asyncio.gather(user_task(alice), user_task(bob))
    assert seen[alice] != seen[bob]
    assert get_user_workspace() is None
