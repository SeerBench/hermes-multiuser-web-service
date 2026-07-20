"""Billing/usage endpoints: proxy new-api token usage + logs."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from tests.platform.conftest import bind_upstream_key, register_user


def test_billing_usage_requires_bound_key(client, mock_upstream_key):
    _, cookie = register_user(client)
    resp = client.get("/api/v1/billing/usage", cookies={"hermes_session": cookie})
    assert resp.status_code == 403


def test_billing_usage_proxies_new_api(client, mock_upstream_key):
    _, cookie = register_user(client)
    bind_upstream_key(client)

    fake = MagicMock()
    fake.status_code = 200
    fake.json.return_value = {
        "code": True,
        "message": "ok",
        "data": {
            "object": "token_usage",
            "name": "Default",
            "total_granted": 1000,
            "total_used": 100,
            "total_available": 900,
            "unlimited_quota": False,
            "expires_at": 0,
        },
    }

    with patch("platform_api.routers.billing.httpx.Client") as Client:
        Client.return_value.__enter__.return_value.get.return_value = fake
        resp = client.get(
            "/api/v1/billing/usage",
            cookies={"hermes_session": cookie},
        )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total_available"] == 900
    assert body["total_used"] == 100
    assert body["name"] == "Default"


def test_billing_logs_proxies_new_api(client, mock_upstream_key):
    _, cookie = register_user(client)
    bind_upstream_key(client)

    fake = MagicMock()
    fake.status_code = 200
    fake.json.return_value = {
        "success": True,
        "data": [
            {
                "id": 1,
                "type": 2,
                "content": "ok",
                "model_name": "gpt-test",
                "quota": 10,
                "created_at": 1700000000,
            }
        ],
    }

    with patch("platform_api.routers.billing.httpx.Client") as Client:
        Client.return_value.__enter__.return_value.get.return_value = fake
        resp = client.get(
            "/api/v1/billing/logs",
            cookies={"hermes_session": cookie},
        )

    assert resp.status_code == 200, resp.text
    items = resp.json()["items"]
    assert len(items) == 1
    assert items[0]["model_name"] == "gpt-test"
    # Never leak the raw API key in the response.
    assert "sk-" not in resp.text.lower() or "sk-test" not in resp.text
