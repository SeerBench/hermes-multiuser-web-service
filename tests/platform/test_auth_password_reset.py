"""Forgot / reset password email flow (test-first)."""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import update

from gateway.web.platform.database import session_scope
from gateway.web.platform.models import PasswordResetToken
from platform_api.deps import get_store
from platform_api.services.rate_limit import reset_login_rate_limiter_for_tests
from tests.platform.conftest import register_user


class RecordingMailer:
    def __init__(self) -> None:
        self.messages: list[dict] = []

    def send(self, *, to: str, subject: str, body: str) -> None:
        self.messages.append({"to": to, "subject": subject, "body": body})


@pytest.fixture()
def mailer(monkeypatch):
    fake = RecordingMailer()
    monkeypatch.setattr("platform_api.routers.auth.get_mailer", lambda: fake)
    return fake


def _token_from_mail(mailer: RecordingMailer) -> str:
    body = mailer.messages[-1]["body"]
    return body.split("token=")[1].split()[0].strip()


def test_forgot_unknown_email_still_ok_and_sends_nothing(client, mailer):
    resp = client.post(
        "/api/v1/auth/forgot-password",
        json={"email": "nobody@example.com"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "ok"
    assert mailer.messages == []


def test_forgot_known_email_sends_reset_link(client, mailer):
    register_user(client, email="reset-me@example.com")
    client.post("/api/v1/auth/logout")

    resp = client.post(
        "/api/v1/auth/forgot-password",
        json={"email": "reset-me@example.com"},
    )
    assert resp.status_code == 200
    assert len(mailer.messages) == 1
    msg = mailer.messages[0]
    assert msg["to"] == "reset-me@example.com"
    assert "#/reset-password?token=" in msg["body"]


def test_reset_password_with_token_changes_password_and_revokes_sessions(
    client, mailer,
):
    register_user(client, email="chg@example.com")
    assert client.get("/api/v1/auth/me").status_code == 200

    client.post("/api/v1/auth/logout")
    assert (
        client.post(
            "/api/v1/auth/forgot-password",
            json={"email": "chg@example.com"},
        ).status_code
        == 200
    )
    token = _token_from_mail(mailer)

    login = client.post(
        "/api/v1/auth/login",
        json={"email": "chg@example.com", "password": "password123"},
    )
    assert login.status_code == 200
    old_cookie = login.cookies.get("hermes_session")
    assert old_cookie

    reset = client.post(
        "/api/v1/auth/reset-password",
        json={"token": token, "new_password": "new-secret-99"},
    )
    assert reset.status_code == 200, reset.text

    me = client.get("/api/v1/auth/me", cookies={"hermes_session": old_cookie})
    assert me.status_code == 401

    assert (
        client.post(
            "/api/v1/auth/login",
            json={"email": "chg@example.com", "password": "password123"},
        ).status_code
        == 401
    )
    ok = client.post(
        "/api/v1/auth/login",
        json={"email": "chg@example.com", "password": "new-secret-99"},
    )
    assert ok.status_code == 200


def test_reset_token_cannot_be_reused(client, mailer):
    register_user(client, email="once@example.com")
    client.post("/api/v1/auth/logout")
    client.post(
        "/api/v1/auth/forgot-password",
        json={"email": "once@example.com"},
    )
    token = _token_from_mail(mailer)

    assert (
        client.post(
            "/api/v1/auth/reset-password",
            json={"token": token, "new_password": "aaaaaaaa"},
        ).status_code
        == 200
    )
    again = client.post(
        "/api/v1/auth/reset-password",
        json={"token": token, "new_password": "bbbbbbbb"},
    )
    assert again.status_code == 400


def test_expired_reset_token_rejected(client, mailer):
    register_user(client, email="exp@example.com")
    client.post("/api/v1/auth/logout")
    client.post(
        "/api/v1/auth/forgot-password",
        json={"email": "exp@example.com"},
    )
    token = _token_from_mail(mailer)

    store = get_store()
    th = hashlib.sha256(token.encode()).hexdigest()
    past = datetime.now(timezone.utc) - timedelta(hours=2)
    with session_scope(store._engine) as db:
        db.execute(
            update(PasswordResetToken)
            .where(PasswordResetToken.token_hash == th)
            .values(expires_at=past)
        )

    bad = client.post(
        "/api/v1/auth/reset-password",
        json={"token": token, "new_password": "cccccccc"},
    )
    assert bad.status_code == 400


def test_forgot_password_rate_limited(client, mailer, monkeypatch):
    monkeypatch.setenv("PLATFORM_LOGIN_MAX_FAILURES", "3")
    monkeypatch.setenv("PLATFORM_LOGIN_WINDOW_SECONDS", "300")
    reset_login_rate_limiter_for_tests()

    register_user(client, email="lim@example.com")
    client.post("/api/v1/auth/logout")

    for _ in range(3):
        assert (
            client.post(
                "/api/v1/auth/forgot-password",
                json={"email": "lim@example.com"},
            ).status_code
            == 200
        )

    blocked = client.post(
        "/api/v1/auth/forgot-password",
        json={"email": "lim@example.com"},
    )
    assert blocked.status_code == 429, blocked.text
