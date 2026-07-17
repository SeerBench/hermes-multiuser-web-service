"""Login failure rate-limit tests (test-first for auth hardening)."""

from __future__ import annotations

from platform_api.services.rate_limit import (
    RateLimitConfig,
    SlidingWindowLimiter,
    reset_login_rate_limiter_for_tests,
)


def test_sliding_window_blocks_after_max_failures():
    limiter = SlidingWindowLimiter(RateLimitConfig(max_failures=3, window_seconds=60))
    key = "login:a@b.com:127.0.0.1"
    assert not limiter.is_blocked(key)
    limiter.record_failure(key, now=1.0)
    limiter.record_failure(key, now=2.0)
    limiter.record_failure(key, now=3.0)
    assert limiter.is_blocked(key, now=4.0)
    assert limiter.remaining(key, now=4.0) == 0


def test_sliding_window_expires_and_clears():
    limiter = SlidingWindowLimiter(RateLimitConfig(max_failures=2, window_seconds=10))
    key = "k"
    limiter.record_failure(key, now=1.0)
    limiter.record_failure(key, now=2.0)
    assert limiter.is_blocked(key, now=5.0)
    # Window rolled past both events.
    assert not limiter.is_blocked(key, now=13.0)
    limiter.clear(key)
    assert limiter.remaining(key, now=13.0) == 2


def test_login_returns_429_after_repeated_failures(client, monkeypatch):
    monkeypatch.setenv("PLATFORM_LOGIN_MAX_FAILURES", "3")
    monkeypatch.setenv("PLATFORM_LOGIN_WINDOW_SECONDS", "300")
    reset_login_rate_limiter_for_tests()

    client.post(
        "/api/v1/auth/register",
        json={"email": "rate@example.com", "password": "password123"},
    )
    client.post("/api/v1/auth/logout")

    for _ in range(3):
        bad = client.post(
            "/api/v1/auth/login",
            json={"email": "rate@example.com", "password": "wrong-password"},
        )
        assert bad.status_code == 401, bad.text

    blocked = client.post(
        "/api/v1/auth/login",
        json={"email": "rate@example.com", "password": "wrong-password"},
    )
    assert blocked.status_code == 429, blocked.text
    assert "too many" in blocked.json()["detail"].lower()

    # Even the correct password is blocked until the window clears.
    still = client.post(
        "/api/v1/auth/login",
        json={"email": "rate@example.com", "password": "password123"},
    )
    assert still.status_code == 429


def test_successful_login_clears_failures(client, monkeypatch):
    monkeypatch.setenv("PLATFORM_LOGIN_MAX_FAILURES", "5")
    monkeypatch.setenv("PLATFORM_LOGIN_WINDOW_SECONDS", "300")
    reset_login_rate_limiter_for_tests()

    client.post(
        "/api/v1/auth/register",
        json={"email": "ok@example.com", "password": "password123"},
    )
    client.post("/api/v1/auth/logout")

    for _ in range(2):
        assert (
            client.post(
                "/api/v1/auth/login",
                json={"email": "ok@example.com", "password": "nope"},
            ).status_code
            == 401
        )

    good = client.post(
        "/api/v1/auth/login",
        json={"email": "ok@example.com", "password": "password123"},
    )
    assert good.status_code == 200
    assert good.cookies.get("hermes_session")
