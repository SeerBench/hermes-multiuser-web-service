"""Cookie Secure flag + production cookie settings checks."""

from __future__ import annotations

from platform_api import deps


def test_register_sets_secure_cookie_when_configured(client, monkeypatch):
    monkeypatch.setenv("PLATFORM_COOKIE_SECURE", "true")
    deps.get_settings.cache_clear()
    try:
        resp = client.post(
            "/api/v1/auth/register",
            json={"email": "secure@example.com", "password": "password123"},
        )
        assert resp.status_code == 200, resp.text
        # Starlette exposes set-cookie via headers / cookies jar.
        set_cookie = resp.headers.get("set-cookie", "")
        assert "hermes_session=" in set_cookie
        assert "Secure" in set_cookie or "secure" in set_cookie.lower()
        assert "HttpOnly" in set_cookie or "httponly" in set_cookie.lower()
    finally:
        monkeypatch.setenv("PLATFORM_COOKIE_SECURE", "false")
        deps.get_settings.cache_clear()


def test_register_omits_secure_cookie_by_default(client):
    resp = client.post(
        "/api/v1/auth/register",
        json={"email": "insecure-dev@example.com", "password": "password123"},
    )
    assert resp.status_code == 200, resp.text
    set_cookie = resp.headers.get("set-cookie", "")
    assert "hermes_session=" in set_cookie
    # Local/dev default: Secure flag must not be set.
    assert "secure" not in set_cookie.lower().replace("hermes_session", "")
