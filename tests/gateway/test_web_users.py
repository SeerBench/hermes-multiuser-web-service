"""Tests for ``gateway.web.users.UserStore``.

Covers the multi-tenant control plane: account create/login, API key
sign/verify/revoke, browser session cookie issuance/expiry, and the
rolling 30-day quota window with auto-reset.
"""

import time

import pytest

from gateway.web.users import (
    DEFAULT_QUOTA_TOKENS,
    DuplicateEmailError,
    InvalidCredentialsError,
    UserStore,
    UserStoreError,
)


@pytest.fixture
def store(tmp_path):
    s = UserStore(tmp_path / "web_users.db")
    yield s
    s.close()


# ── User lifecycle ──────────────────────────────────────────────────────────


def test_create_user_returns_user_id_and_initial_key(store):
    user_id, key = store.create_user("alice@example.com", "correct horse battery staple")
    assert user_id.startswith("u_")
    assert key is not None
    assert key.startswith("hermes_sk_")
    # User row exists and is enabled by default.
    user = store.get_user(user_id)
    assert user["email"] == "alice@example.com"
    assert user["disabled"] == 0
    assert user["quota_tokens"] == DEFAULT_QUOTA_TOKENS


def test_create_user_normalises_email_case_and_whitespace(store):
    user_id, _ = store.create_user("  Alice@Example.COM  ", "long enough password")
    assert store.get_user(user_id)["email"] == "alice@example.com"


def test_create_user_rejects_duplicate_email_case_insensitively(store):
    store.create_user("alice@example.com", "long enough password")
    with pytest.raises(DuplicateEmailError):
        store.create_user("ALICE@example.com", "different long pw")


def test_create_user_rejects_short_password(store):
    with pytest.raises(UserStoreError):
        store.create_user("a@b.co", "short")


def test_create_user_rejects_invalid_email(store):
    with pytest.raises(UserStoreError):
        store.create_user("not-an-email", "long enough password")


def test_create_user_without_initial_key(store):
    user_id, key = store.create_user(
        "alice@example.com", "long enough password", sign_initial_key=False
    )
    assert key is None
    assert store.list_api_keys(user_id) == []


# ── Password verification ──────────────────────────────────────────────────


def test_verify_password_success_returns_user_id(store):
    user_id, _ = store.create_user("alice@example.com", "long enough password")
    assert store.verify_password("alice@example.com", "long enough password") == user_id


def test_verify_password_wrong_password_raises(store):
    store.create_user("alice@example.com", "long enough password")
    with pytest.raises(InvalidCredentialsError):
        store.verify_password("alice@example.com", "wrong password")


def test_verify_password_unknown_email_raises(store):
    with pytest.raises(InvalidCredentialsError):
        store.verify_password("nobody@example.com", "any password")


def test_verify_password_disabled_user_raises(store):
    user_id, _ = store.create_user("alice@example.com", "long enough password")
    store.set_disabled(user_id, True)
    with pytest.raises(InvalidCredentialsError):
        store.verify_password("alice@example.com", "long enough password")


# ── API keys ────────────────────────────────────────────────────────────────


def test_create_api_key_unique(store):
    user_id, k1 = store.create_user("a@b.co", "long enough password")
    _, k2 = store.create_api_key(user_id)
    assert k1 != k2


def test_verify_api_key_returns_user_id(store):
    user_id, k = store.create_user("a@b.co", "long enough password")
    assert store.verify_api_key(k) == user_id


def test_verify_api_key_unknown_raises(store):
    with pytest.raises(InvalidCredentialsError):
        store.verify_api_key("hermes_sk_deadbeef" * 8)


def test_verify_api_key_rejects_wrong_prefix(store):
    with pytest.raises(InvalidCredentialsError):
        store.verify_api_key("sk_xxxx")
    with pytest.raises(InvalidCredentialsError):
        store.verify_api_key("")


def test_revoke_api_key_invalidates_it(store):
    user_id, k = store.create_user("a@b.co", "long enough password")
    keys = store.list_api_keys(user_id)
    assert len(keys) == 1
    key_id = keys[0]["key_id"]
    assert store.revoke_api_key(key_id, user_id) is True
    with pytest.raises(InvalidCredentialsError):
        store.verify_api_key(k)


def test_revoke_api_key_cross_user_returns_false(store):
    a_id, _ = store.create_user("a@b.co", "long enough password")
    b_id, _ = store.create_user("b@c.co", "long enough password")
    a_key_id = store.list_api_keys(a_id)[0]["key_id"]
    # Bob can't revoke Alice's key.
    assert store.revoke_api_key(a_key_id, b_id) is False


def test_disabled_user_cannot_verify_via_api_key(store):
    user_id, k = store.create_user("a@b.co", "long enough password")
    store.set_disabled(user_id, True)
    with pytest.raises(InvalidCredentialsError):
        store.verify_api_key(k)


def test_list_api_keys_returns_prefix_not_plaintext(store):
    user_id, k = store.create_user("a@b.co", "long enough password")
    keys = store.list_api_keys(user_id)
    assert len(keys) == 1
    row = keys[0]
    # Prefix is the visible-display part, not the full key.
    assert row["key_prefix"].startswith("hermes_sk_")
    assert k.startswith(row["key_prefix"])
    assert row["key_prefix"] != k
    assert "key_hash" not in row  # never surfaced


# ── Browser sessions (cookies) ─────────────────────────────────────────────


def test_create_and_verify_web_session(store):
    user_id, _ = store.create_user("a@b.co", "long enough password")
    token = store.create_web_session(user_id)
    assert token.startswith("hermes_ws_")
    assert store.verify_web_session(token) == user_id


def test_web_session_expires(store, monkeypatch):
    user_id, _ = store.create_user("a@b.co", "long enough password")
    # 1-second TTL for the test
    token = store.create_web_session(user_id, ttl_seconds=1)
    # Force "now" forward past expiry
    real_time = time.time
    monkeypatch.setattr("gateway.web.users.time.time", lambda: real_time() + 10)
    with pytest.raises(InvalidCredentialsError):
        store.verify_web_session(token)


def test_delete_web_session(store):
    user_id, _ = store.create_user("a@b.co", "long enough password")
    token = store.create_web_session(user_id)
    store.delete_web_session(token)
    with pytest.raises(InvalidCredentialsError):
        store.verify_web_session(token)


def test_purge_expired_web_sessions(store, monkeypatch):
    user_id, _ = store.create_user("a@b.co", "long enough password")
    store.create_web_session(user_id, ttl_seconds=1)
    store.create_web_session(user_id, ttl_seconds=1)
    real_time = time.time
    monkeypatch.setattr("gateway.web.users.time.time", lambda: real_time() + 10)
    deleted = store.purge_expired_web_sessions()
    assert deleted == 2


def test_disabled_user_cannot_verify_web_session(store):
    user_id, _ = store.create_user("a@b.co", "long enough password")
    token = store.create_web_session(user_id)
    store.set_disabled(user_id, True)
    with pytest.raises(InvalidCredentialsError):
        store.verify_web_session(token)


# ── Quota ──────────────────────────────────────────────────────────────────


def test_check_quota_initial_state(store):
    user_id, _ = store.create_user("a@b.co", "long enough password")
    q = store.check_quota(user_id)
    assert q["used"] == 0
    assert q["limit"] == DEFAULT_QUOTA_TOKENS
    assert q["remaining"] == DEFAULT_QUOTA_TOKENS
    assert q["exceeded"] is False


def test_add_usage_increments(store):
    user_id, _ = store.create_user("a@b.co", "long enough password")
    q1 = store.add_usage(user_id, 100)
    assert q1["used"] == 100
    q2 = store.add_usage(user_id, 250)
    assert q2["used"] == 350


def test_add_usage_marks_exceeded(store):
    user_id, _ = store.create_user("a@b.co", "long enough password")
    store.set_quota_limit(user_id, 1000)
    q = store.add_usage(user_id, 1000)
    assert q["exceeded"] is True
    assert q["remaining"] == 0


def test_quota_window_auto_rolls_after_30_days(store, monkeypatch):
    user_id, _ = store.create_user("a@b.co", "long enough password")
    store.set_quota_limit(user_id, 1000)
    store.add_usage(user_id, 500)
    # Jump 31 days forward
    real_time = time.time
    monkeypatch.setattr(
        "gateway.web.users.time.time", lambda: real_time() + 31 * 24 * 3600
    )
    q = store.add_usage(user_id, 100)
    # Old window flushed — new window starts at 100.
    assert q["used"] == 100
    assert q["exceeded"] is False


def test_reset_quota_period_admin(store):
    user_id, _ = store.create_user("a@b.co", "long enough password")
    store.add_usage(user_id, 500)
    store.reset_quota_period(user_id)
    assert store.check_quota(user_id)["used"] == 0


def test_add_usage_negative_tokens_raises(store):
    user_id, _ = store.create_user("a@b.co", "long enough password")
    with pytest.raises(UserStoreError):
        store.add_usage(user_id, -1)


# ── Cross-user isolation ───────────────────────────────────────────────────


def test_quota_isolation_between_users(store):
    a_id, _ = store.create_user("a@b.co", "long enough password")
    b_id, _ = store.create_user("b@c.co", "long enough password")
    store.add_usage(a_id, 5000)
    assert store.check_quota(b_id)["used"] == 0


def test_api_key_isolation_between_users(store):
    a_id, a_key = store.create_user("a@b.co", "long enough password")
    b_id, b_key = store.create_user("b@c.co", "long enough password")
    assert store.verify_api_key(a_key) == a_id
    assert store.verify_api_key(b_key) == b_id
    # Alice's key list does not contain Bob's key
    a_keys = {k["key_id"] for k in store.list_api_keys(a_id)}
    b_keys = {k["key_id"] for k in store.list_api_keys(b_id)}
    assert a_keys.isdisjoint(b_keys)


def test_terminal_grant_default_off(store):
    user_id, _ = store.create_user("a@b.co", "long enough password")
    assert store.get_user(user_id)["terminal_enabled"] == 0
    store.set_terminal_enabled(user_id, True)
    assert store.get_user(user_id)["terminal_enabled"] == 1
