"""Profile update + favorite_models preferences."""

from __future__ import annotations

from tests.platform.conftest import bind_upstream_key, register_user


def test_patch_me_updates_nickname_email(client, mock_upstream_key):
    data, cookie = register_user(client, email="old@example.com", password="password123")
    assert data["user"]["email"] == "old@example.com"

    resp = client.patch(
        "/api/v1/auth/me",
        json={"nickname": "Ada", "email": "new@example.com"},
        cookies={"hermes_session": cookie},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["nickname"] == "Ada"
    assert body["email"] == "new@example.com"

    me = client.get("/api/v1/auth/me", cookies={"hermes_session": cookie}).json()
    assert me["nickname"] == "Ada"
    assert me["email"] == "new@example.com"


def test_change_password_requires_current(client, mock_upstream_key):
    _, cookie = register_user(client, email="pw@example.com", password="password123")

    bad = client.post(
        "/api/v1/auth/change-password",
        json={"current_password": "wrong-pass", "new_password": "password456"},
        cookies={"hermes_session": cookie},
    )
    assert bad.status_code == 401

    ok = client.post(
        "/api/v1/auth/change-password",
        json={"current_password": "password123", "new_password": "password456"},
        cookies={"hermes_session": cookie},
    )
    assert ok.status_code == 200, ok.text

    # Old password fails; new works.
    fail = client.post(
        "/api/v1/auth/login",
        json={"email": "pw@example.com", "password": "password123"},
    )
    assert fail.status_code == 401
    good = client.post(
        "/api/v1/auth/login",
        json={"email": "pw@example.com", "password": "password456"},
    )
    assert good.status_code == 200


def test_favorite_models_preference(client, mock_upstream_key):
    data, cookie = register_user(client)
    bind_upstream_key(client)
    ws_id = data["workspace"]["id"]

    resp = client.patch(
        f"/api/v1/workspaces/{ws_id}/preferences",
        json={"favorite_models": ["glm-4", "gpt-test"]},
        cookies={"hermes_session": cookie},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["favorite_models"] == ["glm-4", "gpt-test"]

    got = client.get(
        f"/api/v1/workspaces/{ws_id}/preferences",
        cookies={"hermes_session": cookie},
    ).json()
    assert got["favorite_models"] == ["glm-4", "gpt-test"]
