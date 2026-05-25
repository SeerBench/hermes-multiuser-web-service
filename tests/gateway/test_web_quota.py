"""Tests for ``gateway.web.quota.QuotaGate`` — preflight + record + HTTP.

Covers the contract:

- ``preflight`` rolls the 30-day window before reading, so a stale
  user gets a fresh window without a separate "reset" call.
- ``preflight`` raises ``HTTPTooManyRequests`` when over-quota, with
  ``X-Quota-*`` headers.
- ``record`` adds tokens and returns post-update state.
- ``record(0)`` is a no-op increment (still rolls if needed).
- ``record`` never raises on quota-exceeded — the agent already ran;
  future requests' preflight will gate.
- ``attach_quota_headers`` injects the same headers on success responses.
"""

import time

import pytest
from aiohttp import web

from gateway.web.quota import QuotaGate, attach_quota_headers
from gateway.web.users import UserStore


@pytest.fixture
def store(tmp_path):
    s = UserStore(tmp_path / "web_users.db")
    yield s
    s.close()


@pytest.fixture
def gate(store):
    return QuotaGate(store)


@pytest.fixture
def user_id(store):
    uid, _ = store.create_user("a@b.co", "long enough password")
    return uid


# ── preflight ──────────────────────────────────────────────────────────────


def test_preflight_passes_when_under_quota(gate, user_id):
    state = gate.preflight(user_id)
    assert state["used"] == 0
    assert state["remaining"] > 0
    assert state["exceeded"] is False


def test_preflight_raises_429_when_over_quota(store, gate, user_id):
    store.set_quota_limit(user_id, 100)
    store.add_usage(user_id, 100)
    with pytest.raises(web.HTTPTooManyRequests) as excinfo:
        gate.preflight(user_id)
    # Headers attached
    assert excinfo.value.headers["X-Quota-Used"] == "100"
    assert excinfo.value.headers["X-Quota-Limit"] == "100"
    assert excinfo.value.headers["X-Quota-Remaining"] == "0"


def test_preflight_rolls_window_for_stale_user(store, gate, user_id, monkeypatch):
    """A user who was over-quota 35 days ago should preflight clean
    today — preflight calls add_usage(0), which rolls the window if
    elapsed.
    """
    store.set_quota_limit(user_id, 100)
    store.add_usage(user_id, 100)  # now over quota

    real_time = time.time
    monkeypatch.setattr(
        "gateway.web.users.time.time", lambda: real_time() + 35 * 24 * 3600
    )

    # 35 days later: preflight should pass — window rolled.
    state = gate.preflight(user_id)
    assert state["used"] == 0
    assert state["exceeded"] is False


def test_preflight_unknown_user_returns_500(gate):
    """Auth middleware guarantees user exists; if it doesn't, that's a
    server bug, not a 401."""
    with pytest.raises(web.HTTPInternalServerError):
        gate.preflight("u_does_not_exist")


# ── record ────────────────────────────────────────────────────────────────


def test_record_adds_tokens(gate, user_id):
    state = gate.record(user_id, 250)
    assert state["used"] == 250


def test_record_zero_is_noop_increment(gate, user_id):
    state1 = gate.record(user_id, 0)
    assert state1["used"] == 0
    state2 = gate.record(user_id, 100)
    state3 = gate.record(user_id, 0)
    assert state3["used"] == state2["used"] == 100


def test_record_does_not_raise_on_exceeded(store, gate, user_id):
    store.set_quota_limit(user_id, 100)
    # Agent ran, consumed 500 tokens (overshoot allowed once)
    state = gate.record(user_id, 500)
    assert state["used"] == 500
    assert state["exceeded"] is True
    # Next preflight will 429 — but record itself didn't raise.


def test_record_unknown_user_swallows_error(gate):
    """record is best-effort: a failure to write usage must not crash
    the request that already succeeded. Returns a sentinel state."""
    state = gate.record("u_does_not_exist", 100)
    assert state["used"] == -1  # sentinel
    assert state["exceeded"] is False


# ── attach_quota_headers ──────────────────────────────────────────────────


def test_attach_quota_headers_merges_onto_response(gate, user_id):
    state = gate.preflight(user_id)
    resp = web.json_response({"ok": True})
    attach_quota_headers(resp, state)
    assert resp.headers["X-Quota-Used"] == str(state["used"])
    assert resp.headers["X-Quota-Limit"] == str(state["limit"])
    assert resp.headers["X-Quota-Remaining"] == str(state["remaining"])
