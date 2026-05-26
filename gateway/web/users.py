"""User records and browser sessions for ``web_chat``.

Backed by an isolated SQLite database at ``$HERMES_HOME/web_users.db``.
Intentionally separate from ``state.db`` so the multi-tenant control plane
is decoupled from the conversation transcript store — backup, migration,
and admin tooling cleanly target one or the other.

Account model
-------------
Identity comes from the upstream ``new-api`` gateway — users do not
register here.  When a user logs in by pasting their new-api key, the
key is validated against the upstream (see
:mod:`gateway.web.upstream_validator`) and a stable ``user_id`` is
derived from ``sha256(key)`` (see
:func:`gateway.web.upstream_key.derive_user_id`).  This ``user_id`` is
the workspace and SessionDB partition key.

Identifiers
-----------
- ``user_id``    ``u_<12hex>`` — derived deterministically from the
                                  user's new-api key.  Same key, same
                                  ``user_id`` in every browser, so the
                                  user sees the same conversation
                                  history across devices.
- Web session   ``hermes_ws_<64hex>``  — one-shot return at sign-in;
                                          we store ``sha256(plaintext)``.

Encrypted key storage
---------------------
``web_sessions.api_key_enc`` holds the user's new-api key encrypted with
the gateway's :class:`gateway.web.key_storage.KeyVault` master key.
Each chat request decrypts that ciphertext to recover the key, which is
then injected into the LLM call via
:func:`gateway.web.upstream_key.enter_upstream_key` so usage is billed
to the right new-api account.

Concurrency
-----------
``check_same_thread=False`` + a ``threading.Lock`` around every
operation.  The web_chat platform is the only writer in practice and
traffic is low (reads on every request, writes only on login).  WAL
mode is enabled via the shared
:func:`hermes_state.apply_wal_with_fallback` so NFS / SMB / FUSE
mounts degrade gracefully.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

from hermes_constants import get_hermes_home
from hermes_state import apply_wal_with_fallback

logger = logging.getLogger("hermes.web.users")

# Public, single-quoted format string.
_WEB_SESSION_PREFIX = "hermes_ws_"

# Web session default TTL: 7 days.
_DEFAULT_WEB_SESSION_TTL_SECONDS = 7 * 24 * 3600


_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    created_at REAL NOT NULL,
    last_seen_at REAL NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0,
    metadata TEXT
);

CREATE TABLE IF NOT EXISTS web_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    api_key_enc TEXT NOT NULL,
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_web_sessions_user
    ON web_sessions(user_id);
"""


class UserStoreError(Exception):
    """Base for UserStore-raised errors that callers may want to catch."""


class InvalidCredentialsError(UserStoreError):
    """Raised when a session cookie is unknown / expired / belongs to a
    disabled user.  The pre-new-api ``verify_password`` /
    ``verify_api_key`` methods used to raise this too; in the new-api
    world the same class signals "this cookie is not valid".
    """


# ── Hashing helpers ─────────────────────────────────────────────────────────


def _sha256(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _new_web_session_token() -> str:
    return _WEB_SESSION_PREFIX + secrets.token_hex(32)


class UserStore:
    """Persistent multi-user account store for the web_chat platform.

    Construct once at gateway start, share across requests.  Methods are
    thread-safe.
    """

    _WRITE_MAX_RETRIES = 5
    _WRITE_RETRY_MIN_S = 0.020
    _WRITE_RETRY_MAX_S = 0.100

    def __init__(self, db_path: Optional[Path] = None):
        if db_path is None:
            db_path = get_hermes_home() / "web_users.db"
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        self._lock = threading.Lock()
        self._conn = sqlite3.connect(
            str(self.db_path),
            check_same_thread=False,
            timeout=1.0,
            isolation_level=None,
        )
        self._conn.row_factory = sqlite3.Row
        apply_wal_with_fallback(self._conn, db_label="web_users.db")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._init_schema()

    # ── Init / lifecycle ────────────────────────────────────────────────

    def _init_schema(self) -> None:
        with self._lock:
            self._migrate_legacy_schema_locked()
            self._conn.executescript(_SCHEMA)

    def _migrate_legacy_schema_locked(self) -> None:
        """Drop pre-new-api tables when an old ``web_users.db`` is found.

        The switch to new-api key login (commit ``2751078b8``) is a
        breaking change: ``user_id`` is now derived from
        ``sha256(api_key)`` instead of being random, and ``web_sessions``
        gained a non-nullable ``api_key_enc`` column.  Old user rows
        carry neither a usable key nor a derivable id, so there is
        nothing to preserve — we drop the legacy tables and let the
        ``CREATE TABLE IF NOT EXISTS`` block below rebuild them.

        Detection: the legacy ``users`` table has an ``email`` column;
        the new one does not.  Also drops the obsolete ``api_keys``
        table if present.
        """
        cols = {
            row["name"]
            for row in self._conn.execute("PRAGMA table_info(users)")
        }
        if "email" not in cols:
            return
        logger.warning(
            "web_users.db: legacy auth schema detected (email/password); "
            "dropping web_sessions/api_keys/users to migrate to new-api "
            "key login. Existing local accounts cannot be preserved — "
            "users must sign in again with their new-api key."
        )
        self._conn.executescript(
            "DROP TABLE IF EXISTS web_sessions;\n"
            "DROP TABLE IF EXISTS api_keys;\n"
            "DROP TABLE IF EXISTS users;\n"
        )

    def close(self) -> None:
        with self._lock:
            try:
                self._conn.close()
            except sqlite3.Error:
                pass

    # ── User CRUD ──────────────────────────────────────────────────────

    def upsert_user(self, user_id: str) -> None:
        """Record / refresh a user row keyed by ``user_id``.

        Idempotent.  On first call, inserts with ``created_at = now``.
        On subsequent calls, bumps ``last_seen_at`` so the operator can
        see who's been active.  Either way, the row exists after this
        returns — every login funnels through this method to make the
        guarantee load-bearing.
        """
        if not user_id:
            raise UserStoreError("user_id is required")
        now = time.time()

        def _do(c):
            cur = c.execute(
                "UPDATE users SET last_seen_at = ? WHERE user_id = ?",
                (now, user_id),
            )
            if cur.rowcount == 0:
                c.execute(
                    """INSERT INTO users (user_id, created_at, last_seen_at)
                       VALUES (?, ?, ?)""",
                    (user_id, now, now),
                )

        self._execute_write(_do)

    def get_user(self, user_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            row = self._conn.execute(
                """SELECT user_id, created_at, last_seen_at, disabled, metadata
                   FROM users WHERE user_id = ?""",
                (user_id,),
            ).fetchone()
        return dict(row) if row else None

    def set_disabled(self, user_id: str, disabled: bool) -> None:
        self._execute_write(
            lambda c: c.execute(
                "UPDATE users SET disabled = ? WHERE user_id = ?",
                (1 if disabled else 0, user_id),
            )
        )

    # ── Browser (cookie) sessions ──────────────────────────────────────

    def create_web_session(
        self,
        user_id: str,
        encrypted_api_key: str,
        ttl_seconds: int = _DEFAULT_WEB_SESSION_TTL_SECONDS,
    ) -> str:
        """Sign a new browser cookie token; returns the plaintext token
        (the only time it's ever returned).

        ``encrypted_api_key`` must be the output of
        :meth:`gateway.web.key_storage.KeyVault.encrypt` applied to the
        user's new-api key.  We store the ciphertext so each subsequent
        chat request can recover the plaintext key without the user
        re-typing it.
        """
        if not self.get_user(user_id):
            raise UserStoreError(f"unknown user_id: {user_id}")
        if not encrypted_api_key:
            raise UserStoreError("encrypted_api_key is required")
        plaintext = _new_web_session_token()
        now = time.time()
        self._execute_write(
            lambda c: c.execute(
                """INSERT INTO web_sessions
                       (token_hash, user_id, api_key_enc, created_at, expires_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (
                    _sha256(plaintext),
                    user_id,
                    encrypted_api_key,
                    now,
                    now + ttl_seconds,
                ),
            )
        )
        return plaintext

    def verify_web_session(self, plaintext: str) -> Dict[str, Any]:
        """Resolve a cookie token to ``{user_id, api_key_enc}``.

        Raises :class:`InvalidCredentialsError` for unknown / expired /
        disabled-user cookies.  Callers are responsible for decrypting
        ``api_key_enc`` via the gateway's :class:`KeyVault`.
        """
        if not plaintext or not plaintext.startswith(_WEB_SESSION_PREFIX):
            raise InvalidCredentialsError("bad session")
        h = _sha256(plaintext)
        now = time.time()
        with self._lock:
            row = self._conn.execute(
                """SELECT s.user_id, s.api_key_enc, s.expires_at, u.disabled
                   FROM web_sessions s
                   JOIN users u ON u.user_id = s.user_id
                   WHERE s.token_hash = ?""",
                (h,),
            ).fetchone()
        if not row or row["expires_at"] < now or row["disabled"]:
            raise InvalidCredentialsError("bad session")
        return {"user_id": row["user_id"], "api_key_enc": row["api_key_enc"]}

    def delete_web_session(self, plaintext: str) -> None:
        if not plaintext:
            return
        h = _sha256(plaintext)
        self._execute_write(
            lambda c: c.execute("DELETE FROM web_sessions WHERE token_hash = ?", (h,))
        )

    def purge_expired_web_sessions(self) -> int:
        """Housekeeping: drop expired cookie rows.  Returns count deleted.

        Safe to call from a background tick; idempotent.
        """
        now = time.time()

        def _do(c):
            cur = c.execute("DELETE FROM web_sessions WHERE expires_at < ?", (now,))
            return cur.rowcount

        return self._execute_write(_do)

    # ── Write helper ───────────────────────────────────────────────────

    def _execute_write(self, fn):
        """Run ``fn(conn)`` inside BEGIN IMMEDIATE with jitter retry.

        ``fn`` may return a value (e.g. rowcount); it propagates back to
        the caller after COMMIT.  Mirrors :meth:`hermes_state.SessionDB.
        _execute_write` but simpler (no checkpoint scheduling —
        web_users is low-throughput).
        """
        attempt = 0
        while True:
            try:
                with self._lock:
                    self._conn.execute("BEGIN IMMEDIATE")
                    try:
                        result = fn(self._conn)
                        self._conn.execute("COMMIT")
                        return result
                    except Exception:
                        try:
                            self._conn.execute("ROLLBACK")
                        except sqlite3.Error:
                            pass
                        raise
            except sqlite3.OperationalError as exc:
                msg = str(exc).lower()
                if "locked" not in msg and "busy" not in msg:
                    raise
                attempt += 1
                if attempt > self._WRITE_MAX_RETRIES:
                    raise
                time.sleep(
                    secrets.randbelow(
                        int((self._WRITE_RETRY_MAX_S - self._WRITE_RETRY_MIN_S) * 1000)
                    ) / 1000
                    + self._WRITE_RETRY_MIN_S
                )
