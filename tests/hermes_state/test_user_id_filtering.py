"""Multi-tenant filtering on SessionDB queries (web_chat platform).

Regression guard for the user-isolation feature that ships with the new
``web_chat`` platform.  Two query interfaces gained a ``user_id`` parameter:

- ``SessionDB.list_sessions_rich(user_id=…)``
- ``SessionDB.search_messages(user_id=…)``

Both must:

1. Default to legacy behaviour when ``user_id=None`` (return everything).
2. Filter rows by ``sessions.user_id`` when a value is passed.
3. Apply the same filter on every internal SQL branch — the FTS5 path, the
   trigram-CJK path, and the LIKE fallback used for short / mixed CJK
   queries (#20494).

Companion code change: ``AIAgent._ensure_db_session`` and the compression
fork in ``conversation_compression`` both stopped writing ``user_id=None``
and now propagate ``agent._user_id``.  That side is exercised indirectly —
SessionDB rows tagged with a ``user_id`` flow through the filter cleanly.
"""

import time

import pytest

from hermes_state import SessionDB


@pytest.fixture
def db(tmp_path):
    return SessionDB(tmp_path / "state.db")


def _seed_sessions(db: SessionDB, rows):
    """Create sessions with deterministic started_at and user_id.

    ``rows`` is ``[(session_id, user_id), …]``.
    """
    base = int(time.time()) - 10_000
    for i, (sid, uid) in enumerate(rows):
        db.create_session(sid, source="web_chat", user_id=uid)
        db._conn.execute(
            "UPDATE sessions SET started_at = ? WHERE id = ?",
            (base + i * 100, sid),
        )
    db._conn.commit()


# ── list_sessions_rich ──────────────────────────────────────────────────────


def test_list_sessions_user_id_default_returns_everything(db):
    _seed_sessions(db, [
        ("s1", "u_alice"),
        ("s2", "u_bob"),
        ("s3", None),  # legacy untagged row (CLI / pre-fix gateway session)
    ])
    ids = {s["id"] for s in db.list_sessions_rich()}
    assert ids == {"s1", "s2", "s3"}


def test_list_sessions_filters_by_user_id(db):
    _seed_sessions(db, [
        ("s1", "u_alice"),
        ("s2", "u_bob"),
        ("s3", "u_alice"),
    ])
    alice = {s["id"] for s in db.list_sessions_rich(user_id="u_alice")}
    bob = {s["id"] for s in db.list_sessions_rich(user_id="u_bob")}
    assert alice == {"s1", "s3"}
    assert bob == {"s2"}


def test_list_sessions_user_id_excludes_legacy_untagged_rows(db):
    """user_id="u_alice" must NOT return rows where sessions.user_id IS NULL.

    Otherwise legacy CLI sessions would leak into every web user's view.
    """
    _seed_sessions(db, [
        ("legacy_cli", None),
        ("alice", "u_alice"),
    ])
    visible = {s["id"] for s in db.list_sessions_rich(user_id="u_alice")}
    assert visible == {"alice"}


def test_list_sessions_user_id_unknown_user_returns_empty(db):
    _seed_sessions(db, [("s1", "u_alice")])
    assert db.list_sessions_rich(user_id="u_nobody") == []


def test_list_sessions_combines_user_and_source_filter(db):
    _seed_sessions(db, [
        ("a_web", "u_alice"),
        ("a_cli", "u_alice"),
        ("b_web", "u_bob"),
    ])
    # Force one row to a different source so the AND combination is real
    db._conn.execute("UPDATE sessions SET source = 'cli' WHERE id = 'a_cli'")
    db._conn.commit()
    visible = {
        s["id"]
        for s in db.list_sessions_rich(user_id="u_alice", source="web_chat")
    }
    assert visible == {"a_web"}


def test_list_sessions_user_id_filters_in_order_by_last_active_mode(db):
    """The order_by_last_active path uses a recursive CTE; the user_id
    filter must apply on the CTE seed so user A's sessions never reach
    user B's result set.
    """
    _seed_sessions(db, [
        ("alice_1", "u_alice"),
        ("alice_2", "u_alice"),
        ("bob_1", "u_bob"),
        ("bob_2", "u_bob"),
    ])
    db.append_message("alice_1", role="user", content="hi from alice")
    db.append_message("bob_1", role="user", content="hi from bob")

    alice = {s["id"] for s in db.list_sessions_rich(user_id="u_alice", order_by_last_active=True)}
    bob = {s["id"] for s in db.list_sessions_rich(user_id="u_bob", order_by_last_active=True)}
    assert alice == {"alice_1", "alice_2"}
    assert bob == {"bob_1", "bob_2"}


# ── search_messages ─────────────────────────────────────────────────────────


def test_search_messages_default_returns_everything(db):
    _seed_sessions(db, [("s1", "u_alice"), ("s2", "u_bob")])
    db.append_message("s1", role="user", content="docker deployment plan")
    db.append_message("s2", role="user", content="docker deployment notes")

    hits = db.search_messages("docker")
    ids = {h["session_id"] for h in hits}
    assert ids == {"s1", "s2"}


def test_search_messages_filters_by_user_id(db):
    _seed_sessions(db, [("s1", "u_alice"), ("s2", "u_bob")])
    db.append_message("s1", role="user", content="docker deployment plan")
    db.append_message("s2", role="user", content="docker deployment notes")

    alice = db.search_messages("docker", user_id="u_alice")
    bob = db.search_messages("docker", user_id="u_bob")
    assert {h["session_id"] for h in alice} == {"s1"}
    assert {h["session_id"] for h in bob} == {"s2"}


def test_search_messages_user_id_excludes_legacy_untagged(db):
    _seed_sessions(db, [("legacy", None), ("alice", "u_alice")])
    db.append_message("legacy", role="user", content="docker config")
    db.append_message("alice", role="user", content="docker config")

    hits = db.search_messages("docker", user_id="u_alice")
    assert {h["session_id"] for h in hits} == {"alice"}


def test_search_messages_user_id_applies_to_cjk_like_fallback(db):
    """Short CJK queries (<3 chars per token) route through the LIKE branch.

    The user_id filter must work there too — otherwise CJK users leak
    cross-tenant.
    """
    _seed_sessions(db, [("s1", "u_alice"), ("s2", "u_bob")])
    db.append_message("s1", role="user", content="项目讨论关于部署")
    db.append_message("s2", role="user", content="项目讨论关于部署")

    # Two CJK chars per token → forces the LIKE fallback path.
    hits = db.search_messages("项目", user_id="u_alice")
    assert {h["session_id"] for h in hits} == {"s1"}


def test_search_messages_user_id_applies_to_cjk_trigram_path(db):
    """Long CJK queries (>=3 chars total, >=3 per token) use trigram FTS5.

    Filter must apply there too.
    """
    _seed_sessions(db, [("s1", "u_alice"), ("s2", "u_bob")])
    db.append_message("s1", role="user", content="大别山项目部署方案细节")
    db.append_message("s2", role="user", content="大别山项目部署方案细节")

    hits = db.search_messages("大别山", user_id="u_alice")
    assert {h["session_id"] for h in hits} == {"s1"}


# ── end-to-end: user_id round-trips from create_session through queries ─────


def test_user_id_round_trip_through_create_session(db):
    """user_id passed to create_session must land on the row and feed filters.

    This is the exact path AIAgent._ensure_db_session (run_agent.py:517)
    now uses after the fix.
    """
    db.create_session("alice_sess", source="web_chat", user_id="u_alice")
    db.create_session("bob_sess", source="web_chat", user_id="u_bob")

    row = db._conn.execute(
        "SELECT user_id FROM sessions WHERE id = ?", ("alice_sess",)
    ).fetchone()
    assert row["user_id"] == "u_alice"

    visible = {s["id"] for s in db.list_sessions_rich(user_id="u_alice")}
    assert visible == {"alice_sess"}
