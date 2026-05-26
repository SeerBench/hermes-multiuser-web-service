"""Tests for ``gateway.web.users.UserStore`` (new-api integration era).

The store is now BYO-key: identity comes from the upstream new-api
gateway via the cookie/session flow.  These tests cover the (small)
contract that remains:

- ``upsert_user`` is idempotent and bumps ``last_seen_at``
- web_sessions carry the user's encrypted upstream key
- ``verify_web_session`` returns ``{user_id, api_key_enc}``
- Disabled users are rejected
- Cookie expiry is enforced
"""

import time

import pytest

from gateway.web.users import (
    InvalidCredentialsError,
    UserStore,
    UserStoreError,
)


@pytest.fixture
def store(tmp_path):
    s = UserStore(tmp_path / "web_users.db")
    yield s
    s.close()


# ── upsert_user ─────────────────────────────────────────────────────────────


def test_upsert_user_creates_row_on_first_call(store):
    store.upsert_user("u_abc123def456")
    user = store.get_user("u_abc123def456")
    assert user is not None
    assert user["user_id"] == "u_abc123def456"
    assert user["disabled"] == 0
    assert user["created_at"] > 0
    assert user["last_seen_at"] == user["created_at"]


def test_upsert_user_is_idempotent(store):
    store.upsert_user("u_abc123def456")
    store.upsert_user("u_abc123def456")  # second call, must not raise
    user = store.get_user("u_abc123def456")
    assert user is not None


def test_upsert_user_bumps_last_seen_at(store):
    store.upsert_user("u_abc123def456")
    first = store.get_user("u_abc123def456")["last_seen_at"]
    time.sleep(0.02)
    store.upsert_user("u_abc123def456")
    second = store.get_user("u_abc123def456")["last_seen_at"]
    assert second > first


def test_upsert_user_does_not_touch_created_at(store):
    store.upsert_user("u_abc123def456")
    created = store.get_user("u_abc123def456")["created_at"]
    time.sleep(0.02)
    store.upsert_user("u_abc123def456")
    assert store.get_user("u_abc123def456")["created_at"] == created


def test_upsert_user_rejects_empty(store):
    with pytest.raises(UserStoreError):
        store.upsert_user("")


def test_get_user_returns_none_for_unknown(store):
    assert store.get_user("u_does_not_exist") is None


# ── set_disabled ────────────────────────────────────────────────────────────


def test_set_disabled_blocks_subsequent_session_verification(store):
    store.upsert_user("u_user1")
    token = store.create_web_session("u_user1", "enc-blob-1")
    # Works while enabled.
    assert store.verify_web_session(token)["user_id"] == "u_user1"
    # Disable → next verify fails.
    store.set_disabled("u_user1", True)
    with pytest.raises(InvalidCredentialsError):
        store.verify_web_session(token)


# ── create_web_session / verify_web_session ─────────────────────────────────


def test_create_web_session_returns_token_with_prefix(store):
    store.upsert_user("u_user1")
    token = store.create_web_session("u_user1", "enc-payload-1")
    assert token.startswith("hermes_ws_")
    # token body is 64 hex chars after the prefix → total length 74.
    assert len(token) == len("hermes_ws_") + 64


def test_create_web_session_rejects_unknown_user(store):
    with pytest.raises(UserStoreError):
        store.create_web_session("u_nobody", "enc-payload")


def test_create_web_session_rejects_empty_encrypted_key(store):
    store.upsert_user("u_user1")
    with pytest.raises(UserStoreError):
        store.create_web_session("u_user1", "")


def test_verify_web_session_returns_user_id_and_encrypted_key(store):
    store.upsert_user("u_user1")
    token = store.create_web_session("u_user1", "enc-payload-xyz")
    info = store.verify_web_session(token)
    assert info == {"user_id": "u_user1", "api_key_enc": "enc-payload-xyz"}


def test_verify_web_session_rejects_unknown_token(store):
    with pytest.raises(InvalidCredentialsError):
        store.verify_web_session("hermes_ws_" + "0" * 64)


def test_verify_web_session_rejects_malformed_prefix(store):
    with pytest.raises(InvalidCredentialsError):
        store.verify_web_session("not-a-web-session-token")


def test_verify_web_session_rejects_expired(store):
    store.upsert_user("u_user1")
    token = store.create_web_session("u_user1", "enc-payload", ttl_seconds=0)
    # ttl=0 → expires_at == created_at; first verify after a tiny sleep
    # is past the deadline.
    time.sleep(0.05)
    with pytest.raises(InvalidCredentialsError):
        store.verify_web_session(token)


# ── delete_web_session / purge_expired ──────────────────────────────────────


def test_delete_web_session_invalidates_token(store):
    store.upsert_user("u_user1")
    token = store.create_web_session("u_user1", "enc-payload")
    store.delete_web_session(token)
    with pytest.raises(InvalidCredentialsError):
        store.verify_web_session(token)


def test_delete_web_session_handles_unknown_silently(store):
    store.delete_web_session("hermes_ws_" + "1" * 64)  # must not raise


def test_purge_expired_web_sessions_removes_only_expired(store):
    store.upsert_user("u_user1")
    expired = store.create_web_session("u_user1", "enc-1", ttl_seconds=0)
    active = store.create_web_session("u_user1", "enc-2", ttl_seconds=3600)
    time.sleep(0.05)
    n = store.purge_expired_web_sessions()
    assert n == 1
    with pytest.raises(InvalidCredentialsError):
        store.verify_web_session(expired)
    assert store.verify_web_session(active)["user_id"] == "u_user1"


# ── Concurrency safety / persistence ────────────────────────────────────────


def test_user_row_survives_close_and_reopen(tmp_path):
    db_path = tmp_path / "web_users.db"
    store1 = UserStore(db_path)
    store1.upsert_user("u_persist")
    store1.close()

    store2 = UserStore(db_path)
    user = store2.get_user("u_persist")
    assert user is not None
    assert user["user_id"] == "u_persist"
    store2.close()
