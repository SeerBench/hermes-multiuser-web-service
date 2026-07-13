"""Workspace + per-user filesystem isolation for platform users."""

from __future__ import annotations

from pathlib import Path

import pytest

from gateway.web.sandbox import enter_user_context, get_user_workspace, workspace_for
from platform_api.deps import get_store


def test_uuid_workspace_isolation(client):
    """Two registered users get distinct workspace directories."""
    users = []
    for email in ("u1@example.com", "u2@example.com"):
        r = client.post(
            "/api/v1/auth/register",
            json={"email": email, "password": "password123"},
        )
        assert r.status_code == 200
        users.append(r.json()["user"]["user_id"])

    paths: list[Path] = []
    for uid in users:
        with enter_user_context(uid):
            ws = get_user_workspace()
            assert ws is not None
            marker = ws / "isolation.txt"
            marker.write_text(uid, encoding="utf-8")
            paths.append(ws)

    assert paths[0] != paths[1]
    assert paths[0].name == users[0]
    assert paths[1].name == users[1]

    # Cross-read must fail: u1 workspace cannot access u2 files via confine_path.
    from gateway.web.sandbox import PathSandboxViolation, confine_path

    other = workspace_for(users[1]) / "isolation.txt"
    with enter_user_context(users[0]):
        with pytest.raises(PathSandboxViolation):
            confine_path(str(other))


def test_platform_store_session_shared_with_cookie(client):
    """Platform session cookie verifies via PlatformStore (web_chat compatible)."""
    reg = client.post(
        "/api/v1/auth/register",
        json={"email": "sess@example.com", "password": "password123"},
    )
    cookie = reg.cookies.get("hermes_session")
    assert cookie

    store = get_store()
    session = store.verify_web_session(cookie)
    assert session["user_id"] == reg.json()["user"]["user_id"]
