"""Workspace model list + preferences."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from tests.platform.conftest import bind_upstream_key, register_user


def test_list_models_proxies_new_api(client, platform_env, mock_upstream_key, monkeypatch):
    data, cookie = register_user(client)
    bind_upstream_key(client)
    ws_id = data["workspace"]["id"]

    class _Resp:
        status_code = 200

        def json(self):
            return {"data": [{"id": "gpt-test", "owned_by": "openai"}]}

    mock_client = MagicMock()
    mock_client.__enter__ = lambda s: s
    mock_client.__exit__ = lambda *a: None
    mock_client.get.return_value = _Resp()
    monkeypatch.setattr("platform_api.routers.models.httpx.Client", lambda **kw: mock_client)

    resp = client.get(
        f"/api/v1/workspaces/{ws_id}/models",
        cookies={"hermes_session": cookie},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["models"][0]["id"] == "gpt-test"


def test_patch_preferences_persists_model(client, mock_upstream_key):
    data, cookie = register_user(client)
    bind_upstream_key(client)
    ws_id = data["workspace"]["id"]

    resp = client.patch(
        f"/api/v1/workspaces/{ws_id}/preferences",
        json={"preferred_model": "glm-4"},
        cookies={"hermes_session": cookie},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["preferred_model"] == "glm-4"

    resp2 = client.get(
        f"/api/v1/workspaces/{ws_id}/preferences",
        cookies={"hermes_session": cookie},
    )
    assert resp2.json()["preferred_model"] == "glm-4"


def test_preferences_isolated_between_users(client, mock_upstream_key):
    a, cookie_a = register_user(client, email="a@example.com")
    bind_upstream_key(client)
    b, cookie_b = register_user(client, email="b@example.com")
    bind_upstream_key(client)

    ws_a = a["workspace"]["id"]
    ws_b = b["workspace"]["id"]

    client.patch(
        f"/api/v1/workspaces/{ws_a}/preferences",
        json={"preferred_model": "model-a"},
        cookies={"hermes_session": cookie_a},
    )
    client.patch(
        f"/api/v1/workspaces/{ws_b}/preferences",
        json={"preferred_model": "model-b"},
        cookies={"hermes_session": cookie_b},
    )

    pa = client.get(
        f"/api/v1/workspaces/{ws_a}/preferences",
        cookies={"hermes_session": cookie_a},
    ).json()
    pb = client.get(
        f"/api/v1/workspaces/{ws_b}/preferences",
        cookies={"hermes_session": cookie_b},
    ).json()
    assert pa["preferred_model"] == "model-a"
    assert pb["preferred_model"] == "model-b"
