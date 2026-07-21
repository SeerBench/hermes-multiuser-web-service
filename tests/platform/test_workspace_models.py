"""Workspace model list + preferences."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from tests.platform.conftest import bind_upstream_key, register_user


def _mock_models_http(monkeypatch, model_id: str = "gpt-test"):
    class _Resp:
        status_code = 200

        def json(self):
            return {"data": [{"id": model_id, "owned_by": "openai"}]}

    mock_client = MagicMock()
    mock_client.__enter__ = lambda s: s
    mock_client.__exit__ = lambda *a: None
    mock_client.get.return_value = _Resp()
    monkeypatch.setattr(
        "platform_api.routers.models.httpx.Client",
        lambda **kw: mock_client,
    )
    return mock_client


def test_list_models_proxies_new_api(client, platform_env, mock_upstream_key, monkeypatch):
    data, cookie = register_user(client)
    bind_upstream_key(client)
    ws_id = data["workspace"]["id"]
    _mock_models_http(monkeypatch)

    resp = client.get(
        f"/api/v1/workspaces/{ws_id}/models",
        cookies={"hermes_session": cookie},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["models"][0]["id"] == "gpt-test"


def test_list_models_works_after_legacy_api_key_session(
    client, platform_env, mock_upstream_key, monkeypatch,
):
    """API-key login stores key on the session; /models must still resolve it.

    Gateway ``POST /api/auth/login`` calls upsert_user + create_web_session
    with the encrypted key.  Historically only PlatformSession.api_key_enc
    was set, while list_models read User.upstream_api_key_enc → 403 and an
    empty model picker in the SPA.
    """
    from gateway.web.key_storage import KeyVault
    from platform_api.deps import get_store

    store = get_store()
    vault = KeyVault()
    user_id = "u_legacy_models01"
    store.upsert_user(user_id)
    enc = vault.encrypt("sk-legacy-models-key-aaaaaaaa")
    cookie = store.create_web_session(user_id, enc)
    ws = store.get_default_workspace(user_id)
    assert ws is not None

    # Key must be persisted on the user row (same as bind-key).
    assert store.get_user_upstream_key_enc(user_id)

    mock_client = _mock_models_http(monkeypatch, model_id="legacy-model")
    resp = client.get(
        f"/api/v1/workspaces/{ws['id']}/models",
        cookies={"hermes_session": cookie},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["models"][0]["id"] == "legacy-model"
    # Proxied with the caller's key, not a shared admin key.
    headers = mock_client.get.call_args.kwargs.get("headers") or {}
    assert headers.get("Authorization") == "Bearer sk-legacy-models-key-aaaaaaaa"


def test_list_models_falls_back_to_session_key_when_user_row_empty(
    client, platform_env, mock_upstream_key, monkeypatch,
):
    """Existing sessions created before the user-row sync still work."""
    from gateway.web.key_storage import KeyVault
    from gateway.web.platform.database import session_scope
    from gateway.web.platform.models import User
    from platform_api.deps import get_store

    store = get_store()
    vault = KeyVault()
    user_id = "u_legacy_session_only"
    store.upsert_user(user_id)
    enc = vault.encrypt("sk-session-only-key-bbbbbbbb")
    cookie = store.create_web_session(user_id, enc)

    # Simulate old rows: clear user.upstream_api_key_enc after session create.
    with session_scope(store._engine) as db:
        user = db.get(User, user_id)
        assert user is not None
        user.upstream_api_key_enc = None

    assert store.get_user_upstream_key_enc(user_id) is None
    ws = store.get_default_workspace(user_id)
    assert ws is not None

    _mock_models_http(monkeypatch, model_id="from-session")
    resp = client.get(
        f"/api/v1/workspaces/{ws['id']}/models",
        cookies={"hermes_session": cookie},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["models"][0]["id"] == "from-session"


def test_list_models_403_without_bound_key(client, mock_upstream_key):
    data, cookie = register_user(client, email="nokey@example.com")
    ws_id = data["workspace"]["id"]
    resp = client.get(
        f"/api/v1/workspaces/{ws_id}/models",
        cookies={"hermes_session": cookie},
    )
    assert resp.status_code == 403
    assert "upstream key" in resp.json()["detail"].lower()


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
