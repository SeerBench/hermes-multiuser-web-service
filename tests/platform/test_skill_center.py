"""Skill Center: structured create, enable/disable, config sync, isolation."""

from __future__ import annotations

from gateway.web.sandbox import enter_user_context
from tests.platform.conftest import bind_upstream_key, register_user


def _setup(client, mock_upstream_key, email: str = "skill@example.com"):
    del mock_upstream_key
    body, _ = register_user(client, email=email)
    bind_upstream_key(client)
    return body["user"]["user_id"], body["workspace"]["id"]


def test_structured_create_lists_metadata(client, mock_upstream_key):
    _uid, wid = _setup(client, mock_upstream_key)
    created = client.post(
        f"/api/v1/workspaces/{wid}/skills",
        json={
            "name": "Futures Analysis Helper",
            "description": "Analyze futures markets and produce a short report.",
            "workflow": "1. Fetch quotes\n2. Compute indicators\n3. Write report",
            "inputs": "Market data",
            "outputs": "Analysis report",
            "type": "analysis",
            "version": "1.0",
            "config": {"risk_level": "low"},
        },
    )
    assert created.status_code == 200, created.text
    assert created.json()["success"] is True
    assert created.json()["name"] == "futures-analysis-helper"

    listed = client.get(f"/api/v1/workspaces/{wid}/skills")
    assert listed.status_code == 200
    row = next(s for s in listed.json() if s["name"] == "futures-analysis-helper")
    assert row["source"] == "user"
    assert row["version"] == "1.0"
    assert row["type"] == "analysis"
    assert row["status"] == "enabled"
    assert row["updated_at"]
    assert row["config"].get("risk_level") == "low"

    detail = client.get(
        f"/api/v1/workspaces/{wid}/skills/futures-analysis-helper"
    )
    assert detail.status_code == 200
    body = detail.json()
    assert "Fetch quotes" in body["content"]
    assert body["config"]["risk_level"] == "low"


def test_enable_disable_endpoints(client, mock_upstream_key):
    _uid, wid = _setup(client, mock_upstream_key, email="en@example.com")
    client.post(
        f"/api/v1/workspaces/{wid}/skills",
        json={
            "name": "toggle-skill",
            "description": "Toggle me.",
            "type": "tool",
        },
    )
    disabled = client.post(f"/api/v1/workspaces/{wid}/skills/toggle-skill/disable")
    assert disabled.status_code == 200, disabled.text
    assert disabled.json()["status"] == "disabled"
    assert disabled.json()["enabled"] is False

    listed = client.get(f"/api/v1/workspaces/{wid}/skills").json()
    row = next(s for s in listed if s["name"] == "toggle-skill")
    assert row["status"] == "disabled"

    enabled = client.post(f"/api/v1/workspaces/{wid}/skills/toggle-skill/enable")
    assert enabled.status_code == 200
    assert enabled.json()["status"] == "enabled"


def test_config_patch_writes_config_json(client, mock_upstream_key):
    user_id, wid = _setup(client, mock_upstream_key, email="cfg@example.com")
    client.post(
        f"/api/v1/workspaces/{wid}/skills",
        json={"name": "cfg-skill", "description": "Has config."},
    )
    patched = client.patch(
        f"/api/v1/workspaces/{wid}/skills/cfg-skill",
        json={"config": {"theme": "dark", "max_steps": 3}},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["config"]["theme"] == "dark"

    with enter_user_context(user_id) as ws:
        from platform_api.services.skill_center import find_user_skill_dir, read_config_json

        skill_dir = find_user_skill_dir(ws, "cfg-skill")
        assert skill_dir is not None
        assert read_config_json(skill_dir)["max_steps"] == 3


def test_user_cannot_access_other_workspace_skills(client, mock_upstream_key):
    _uid_a, wid_a = _setup(client, mock_upstream_key, email="sa@example.com")
    client.post(
        f"/api/v1/workspaces/{wid_a}/skills",
        json={"name": "alice-only", "description": "Private."},
    )
    _uid_b, _wid_b = _setup(client, mock_upstream_key, email="sb@example.com")
    denied = client.get(f"/api/v1/workspaces/{wid_a}/skills")
    assert denied.status_code == 404
    denied_del = client.delete(f"/api/v1/workspaces/{wid_a}/skills/alice-only")
    assert denied_del.status_code == 404
