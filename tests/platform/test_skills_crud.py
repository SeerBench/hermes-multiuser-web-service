"""Personal skill REST CRUD."""

from __future__ import annotations

from tests.platform.conftest import bind_upstream_key, register_user

_SKILL = """---
name: demo-skill
description: Demo skill for tests.
version: "1.0"
---

# Demo

## When to Use
Testing.
"""


def test_create_and_delete_user_skill(client, mock_upstream_key):
    data, cookie = register_user(client)
    bind_upstream_key(client)
    ws_id = data["workspace"]["id"]

    created = client.post(
        f"/api/v1/workspaces/{ws_id}/skills",
        json={"name": "demo-skill", "skill_md": _SKILL},
        cookies={"hermes_session": cookie},
    )
    assert created.status_code == 200, created.text
    assert created.json()["success"] is True

    listed = client.get(
        f"/api/v1/workspaces/{ws_id}/skills",
        cookies={"hermes_session": cookie},
    ).json()
    assert any(s["name"] == "demo-skill" and s["source"] == "user" for s in listed)

    replaced = client.put(
        f"/api/v1/workspaces/{ws_id}/skills/demo-skill",
        json={"skill_md": _SKILL.replace("Demo", "Demo v2")},
        cookies={"hermes_session": cookie},
    )
    assert replaced.status_code == 200

    deleted = client.delete(
        f"/api/v1/workspaces/{ws_id}/skills/demo-skill",
        cookies={"hermes_session": cookie},
    )
    assert deleted.status_code == 200

    listed2 = client.get(
        f"/api/v1/workspaces/{ws_id}/skills",
        cookies={"hermes_session": cookie},
    ).json()
    assert not any(s["name"] == "demo-skill" and s["source"] == "user" for s in listed2)
