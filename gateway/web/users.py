"""User accounts, API keys, browser sessions, and quota for ``web_chat``.

Backed by an isolated SQLite database at ``$HERMES_HOME/web_users.db``.
Intentionally separate from ``state.db`` so the multi-tenant control plane
is decoupled from the conversation transcript store — backup, migration,
and admin tooling cleanly target one or the other.

Identifiers
-----------
- ``user_id``      ``u_<12hex>`` — also used as the per-user workspace
                                    subdirectory name under
                                    ``$HERMES_HOME/web_workspaces/``.
- ``key_id``       ``ak_<12hex>``
- API key         ``hermes_sk_<64hex>``  — only returned at creation time;
                                            we store ``sha256(plaintext)``.
- Web session     ``hermes_ws_<64hex>``  — same one-shot return pattern.

Quota
-----
A rolling 30-day window per user.  ``add_usage()`` checks whether the
window has elapsed since ``quota_period_start`` and rolls the counter
before adding.  No cron job required — the next request after the window
ends triggers the reset.

Password hashing
----------------
Argon2id via ``argon2-cffi``.  The dependency is optional and listed under
the ``[web-chat]`` extra in ``pyproject.toml``; if it's missing,
:class:`UserStore` raises at construction time with a clear remediation
hint instead of failing deep inside auth.

Concurrency
-----------
``check_same_thread=False`` + a ``threading.Lock`` around every operation.
The web_chat platform is the only writer in practice and traffic is low
(reads on every request, writes on auth/quota changes), so the lock is
not a bottleneck.  WAL mode is enabled via the shared
:func:`hermes_state.apply_wal_with_fallback` so NFS / SMB / FUSE mounts
degrade gracefully.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from hermes_constants import get_hermes_home
from hermes_state import apply_wal_with_fallback

logger = logging.getLogger("hermes.web.users")

# ── Optional dependency: argon2-cffi ────────────────────────────────────────
# Lazy-import so just `import gateway.web` doesn't drag argon2 into every
# Hermes session.  UserStore.__init__ raises the friendly error if needed.
try:
    from argon2 import PasswordHasher
    from argon2.exceptions import VerifyMismatchError, InvalidHashError
    _ARGON2_AVAILABLE = True
except ImportError:  # pragma: no cover — exercised in environments without the extra
    PasswordHasher = None  # type: ignore[assignment,misc]
    VerifyMismatchError = Exception  # type: ignore[assignment,misc]
    InvalidHashError = Exception  # type: ignore[assignment,misc]
    _ARGON2_AVAILABLE = False


# Public, single-quoted format string — must round-trip through
# UserStore.api_key_prefix_for_display below.
_API_KEY_PREFIX = "hermes_sk_"
_WEB_SESSION_PREFIX = "hermes_ws_"
_USER_ID_PREFIX = "u_"
_API_KEY_ID_PREFIX = "ak_"

# Display prefix length: full key body is 64 hex chars; we surface the first
# 8 so the UI can show e.g. ``hermes_sk_a1b2c3d4…`` for visual recognition
# without leaking enough material to guess the rest.
_DISPLAY_PREFIX_LEN = len(_API_KEY_PREFIX) + 8

# Rolling quota window: 30 days.
_QUOTA_WINDOW_SECONDS = 30 * 24 * 3600

# Default monthly token allowance, can be raised/lowered per user via
# ``set_quota_limit()``.
DEFAULT_QUOTA_TOKENS = 1_000_000

# Web session default TTL: 7 days.
_DEFAULT_WEB_SESSION_TTL_SECONDS = 7 * 24 * 3600


_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at REAL NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0,
    quota_tokens INTEGER NOT NULL DEFAULT 1000000,
    quota_used INTEGER NOT NULL DEFAULT 0,
    quota_period_start REAL NOT NULL,
    terminal_enabled INTEGER NOT NULL DEFAULT 0,
    metadata TEXT
);

CREATE TABLE IF NOT EXISTS api_keys (
    key_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    created_at REAL NOT NULL,
    last_used_at REAL,
    revoked_at REAL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash_active
    ON api_keys(key_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_user
    ON api_keys(user_id);

CREATE TABLE IF NOT EXISTS web_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_web_sessions_user
    ON web_sessions(user_id);
"""


class UserStoreError(Exception):
    """Base for UserStore-raised errors that callers may want to catch."""


class DuplicateEmailError(UserStoreError):
    """Raised when ``create_user`` is called with an email that already exists."""


class InvalidCredentialsError(UserStoreError):
    """Login / key verification failed (wrong password, unknown email, revoked key)."""


class QuotaExceededError(UserStoreError):
    """Raised by ``add_usage`` callers when a user has no remaining quota.

    UserStore itself surfaces the over-quota condition through the
    ``exceeded: True`` field on ``check_quota()`` / ``add_usage()`` return
    values; this exception is provided for callers that prefer to handle
    quota as an exception path rather than a return-value branch.
    """


# ── Hashing helpers ─────────────────────────────────────────────────────────


def _sha256(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _new_user_id() -> str:
    return _USER_ID_PREFIX + secrets.token_hex(6)


def _new_key_id() -> str:
    return _API_KEY_ID_PREFIX + secrets.token_hex(6)


def _new_api_key() -> str:
    return _API_KEY_PREFIX + secrets.token_hex(32)


def _new_web_session_token() -> str:
    return _WEB_SESSION_PREFIX + secrets.token_hex(32)


def _key_prefix_for_display(plaintext_key: str) -> str:
    return plaintext_key[:_DISPLAY_PREFIX_LEN]


class UserStore:
    """Persistent multi-user account store for the web_chat platform.

    Construct once at gateway start, share across requests.  Methods are
    thread-safe.
    """

    _WRITE_MAX_RETRIES = 5
    _WRITE_RETRY_MIN_S = 0.020
    _WRITE_RETRY_MAX_S = 0.100

    def __init__(
        self,
        db_path: Optional[Path] = None,
        *,
        password_hasher: Optional["PasswordHasher"] = None,
    ):
        if not _ARGON2_AVAILABLE and password_hasher is None:
            raise RuntimeError(
                "gateway.web.users.UserStore requires the 'argon2-cffi' package. "
                "Install it with one of:\n"
                "    uv pip install 'hermes-agent[web-chat]'\n"
                "    uv pip install argon2-cffi"
            )

        if db_path is None:
            db_path = get_hermes_home() / "web_users.db"
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        self._lock = threading.Lock()
        # OWASP 2024 recommendation for interactive logins:
        # time_cost=2 iterations, 64 MiB memory, parallelism=2.
        self._hasher = password_hasher or PasswordHasher(
            time_cost=2, memory_cost=65536, parallelism=2
        )

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
            self._conn.executescript(_SCHEMA)

    def close(self) -> None:
        with self._lock:
            try:
                self._conn.close()
            except sqlite3.Error:
                pass

    # ── User CRUD ──────────────────────────────────────────────────────

    def create_user(
        self,
        email: str,
        password: str,
        *,
        quota_tokens: int = DEFAULT_QUOTA_TOKENS,
        sign_initial_key: bool = True,
    ) -> Tuple[str, Optional[str]]:
        """Create a user; optionally sign and return an initial API key.

        Returns ``(user_id, plaintext_api_key_or_None)``.  The plaintext
        key is only ever returned here — there's no way to retrieve it
        later.
        """
        email_norm = email.strip().lower()
        if not email_norm or "@" not in email_norm:
            raise UserStoreError(f"invalid email: {email!r}")
        if not password or len(password) < 8:
            raise UserStoreError("password must be at least 8 characters")

        user_id = _new_user_id()
        now = time.time()
        pwd_hash = self._hasher.hash(password)

        plaintext_key: Optional[str] = None
        with self._lock:
            try:
                self._conn.execute("BEGIN IMMEDIATE")
                self._conn.execute(
                    """INSERT INTO users (
                           user_id, email, password_hash, created_at,
                           quota_tokens, quota_period_start
                       ) VALUES (?, ?, ?, ?, ?, ?)""",
                    (user_id, email_norm, pwd_hash, now, quota_tokens, now),
                )
                if sign_initial_key:
                    plaintext_key = _new_api_key()
                    self._conn.execute(
                        """INSERT INTO api_keys (
                               key_id, user_id, key_hash, key_prefix, created_at
                           ) VALUES (?, ?, ?, ?, ?)""",
                        (
                            _new_key_id(),
                            user_id,
                            _sha256(plaintext_key),
                            _key_prefix_for_display(plaintext_key),
                            now,
                        ),
                    )
                self._conn.execute("COMMIT")
            except sqlite3.IntegrityError as exc:
                self._conn.execute("ROLLBACK")
                if "users.email" in str(exc):
                    raise DuplicateEmailError(email_norm) from exc
                raise
            except Exception:
                self._conn.execute("ROLLBACK")
                raise

        return user_id, plaintext_key

    def verify_password(self, email: str, password: str) -> str:
        """Return the ``user_id`` on success, raise InvalidCredentialsError
        on failure.  Constant-ish timing: we run argon2.verify even when
        the email is unknown to avoid leaking which arm failed.
        """
        email_norm = email.strip().lower()
        with self._lock:
            row = self._conn.execute(
                "SELECT user_id, password_hash, disabled FROM users WHERE email = ?",
                (email_norm,),
            ).fetchone()

        # Run the hasher against either the stored hash or a dummy one so
        # the failure path takes ~the same time.
        target_hash = row["password_hash"] if row else self._hasher.hash("\0" * 32)
        try:
            self._hasher.verify(target_hash, password)
        except VerifyMismatchError as exc:
            raise InvalidCredentialsError("bad credentials") from exc
        except InvalidHashError as exc:  # pragma: no cover — only if DB hash gets corrupted
            raise InvalidCredentialsError("bad credentials") from exc

        if not row or row["disabled"]:
            raise InvalidCredentialsError("bad credentials")

        # Opportunistically rehash if the hasher's parameters changed.
        if self._hasher.check_needs_rehash(row["password_hash"]):
            new_hash = self._hasher.hash(password)
            self._execute_write(
                lambda c: c.execute(
                    "UPDATE users SET password_hash = ? WHERE user_id = ?",
                    (new_hash, row["user_id"]),
                )
            )
        return row["user_id"]

    def get_user(self, user_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            row = self._conn.execute(
                """SELECT user_id, email, created_at, disabled,
                          quota_tokens, quota_used, quota_period_start,
                          terminal_enabled, metadata
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

    def set_terminal_enabled(self, user_id: str, enabled: bool) -> None:
        self._execute_write(
            lambda c: c.execute(
                "UPDATE users SET terminal_enabled = ? WHERE user_id = ?",
                (1 if enabled else 0, user_id),
            )
        )

    def set_quota_limit(self, user_id: str, tokens: int) -> None:
        if tokens < 0:
            raise UserStoreError("quota limit must be non-negative")
        self._execute_write(
            lambda c: c.execute(
                "UPDATE users SET quota_tokens = ? WHERE user_id = ?",
                (int(tokens), user_id),
            )
        )

    def reset_quota_period(self, user_id: str) -> None:
        """Admin-only: force-roll the user's quota window now."""
        now = time.time()
        self._execute_write(
            lambda c: c.execute(
                "UPDATE users SET quota_used = 0, quota_period_start = ? WHERE user_id = ?",
                (now, user_id),
            )
        )

    # ── API keys ───────────────────────────────────────────────────────

    def create_api_key(self, user_id: str) -> Tuple[str, str]:
        """Sign a new API key for ``user_id``.  Returns ``(key_id, plaintext)``.

        ``plaintext`` is shown to the user once and never stored.
        """
        if not self.get_user(user_id):
            raise UserStoreError(f"unknown user_id: {user_id}")
        plaintext = _new_api_key()
        key_id = _new_key_id()
        now = time.time()
        self._execute_write(
            lambda c: c.execute(
                """INSERT INTO api_keys (
                       key_id, user_id, key_hash, key_prefix, created_at
                   ) VALUES (?, ?, ?, ?, ?)""",
                (key_id, user_id, _sha256(plaintext), _key_prefix_for_display(plaintext), now),
            )
        )
        return key_id, plaintext

    def verify_api_key(self, plaintext: str) -> str:
        """Return the ``user_id`` for a valid, non-revoked key.

        Updates ``last_used_at`` opportunistically.  Raises
        ``InvalidCredentialsError`` on miss / revoked / disabled user.
        """
        if not plaintext or not plaintext.startswith(_API_KEY_PREFIX):
            raise InvalidCredentialsError("bad key")
        h = _sha256(plaintext)
        with self._lock:
            row = self._conn.execute(
                """SELECT k.key_id, k.user_id, u.disabled
                   FROM api_keys k
                   JOIN users u ON u.user_id = k.user_id
                   WHERE k.key_hash = ? AND k.revoked_at IS NULL""",
                (h,),
            ).fetchone()
        if not row or row["disabled"]:
            raise InvalidCredentialsError("bad key")
        # Best-effort touch — don't fail auth if it errors.
        now = time.time()
        try:
            self._execute_write(
                lambda c: c.execute(
                    "UPDATE api_keys SET last_used_at = ? WHERE key_id = ?",
                    (now, row["key_id"]),
                )
            )
        except sqlite3.Error:
            logger.debug("failed to update last_used_at for %s", row["key_id"], exc_info=True)
        return row["user_id"]

    def list_api_keys(self, user_id: str) -> List[Dict[str, Any]]:
        """Return all keys for ``user_id`` — active and revoked, no plaintext."""
        with self._lock:
            rows = self._conn.execute(
                """SELECT key_id, key_prefix, created_at, last_used_at, revoked_at
                   FROM api_keys WHERE user_id = ?
                   ORDER BY created_at DESC""",
                (user_id,),
            ).fetchall()
        return [dict(r) for r in rows]

    def revoke_api_key(self, key_id: str, user_id: str) -> bool:
        """Revoke a key.  Returns True if the key was found and belonged
        to ``user_id`` (idempotent — a re-revoke still returns True).
        Returns False if the key doesn't exist or belongs to someone else.
        """
        now = time.time()

        def _do(c):
            cur = c.execute(
                """UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?)
                   WHERE key_id = ? AND user_id = ?""",
                (now, key_id, user_id),
            )
            return cur.rowcount

        rowcount = self._execute_write(_do)
        return rowcount > 0

    # ── Browser (cookie) sessions ──────────────────────────────────────

    def create_web_session(
        self,
        user_id: str,
        ttl_seconds: int = _DEFAULT_WEB_SESSION_TTL_SECONDS,
    ) -> str:
        """Sign a new browser cookie token; returns the plaintext token
        (the only time it's ever returned).
        """
        if not self.get_user(user_id):
            raise UserStoreError(f"unknown user_id: {user_id}")
        plaintext = _new_web_session_token()
        now = time.time()
        self._execute_write(
            lambda c: c.execute(
                """INSERT INTO web_sessions (token_hash, user_id, created_at, expires_at)
                   VALUES (?, ?, ?, ?)""",
                (_sha256(plaintext), user_id, now, now + ttl_seconds),
            )
        )
        return plaintext

    def verify_web_session(self, plaintext: str) -> str:
        """Return ``user_id`` for a valid non-expired cookie.  Raises
        :class:`InvalidCredentialsError` otherwise.
        """
        if not plaintext or not plaintext.startswith(_WEB_SESSION_PREFIX):
            raise InvalidCredentialsError("bad session")
        h = _sha256(plaintext)
        now = time.time()
        with self._lock:
            row = self._conn.execute(
                """SELECT s.user_id, s.expires_at, u.disabled
                   FROM web_sessions s
                   JOIN users u ON u.user_id = s.user_id
                   WHERE s.token_hash = ?""",
                (h,),
            ).fetchone()
        if not row or row["expires_at"] < now or row["disabled"]:
            raise InvalidCredentialsError("bad session")
        return row["user_id"]

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

    # ── Quota ──────────────────────────────────────────────────────────

    def check_quota(self, user_id: str) -> Dict[str, Any]:
        """Return current quota state.  Does NOT roll the window — call
        ``add_usage(user_id, 0)`` if you want the side-effect of rolling
        a stale window before reading.
        """
        u = self.get_user(user_id)
        if not u:
            raise UserStoreError(f"unknown user_id: {user_id}")
        used = u["quota_used"]
        limit = u["quota_tokens"]
        return {
            "used": used,
            "limit": limit,
            "remaining": max(0, limit - used),
            "period_start": u["quota_period_start"],
            "exceeded": used >= limit,
        }

    def add_usage(self, user_id: str, tokens: int) -> Dict[str, Any]:
        """Increment usage, rolling the 30-day window if it has elapsed.

        Returns the post-update state in the same shape as
        :meth:`check_quota`.  Raises :class:`UserStoreError` on unknown
        user.  Does NOT raise on over-quota — the caller decides whether
        to enforce based on ``exceeded`` in the returned dict.  ``tokens``
        may be 0 to just roll the window without incrementing.
        """
        if tokens < 0:
            raise UserStoreError(f"tokens must be non-negative, got {tokens}")
        now = time.time()

        def _do(c):
            row = c.execute(
                """SELECT quota_used, quota_tokens, quota_period_start
                   FROM users WHERE user_id = ?""",
                (user_id,),
            ).fetchone()
            if not row:
                return None
            period_start = row["quota_period_start"]
            limit = row["quota_tokens"]
            used = row["quota_used"]
            if now - period_start >= _QUOTA_WINDOW_SECONDS:
                # Roll the window.
                period_start = now
                used = 0
            new_used = used + int(tokens)
            c.execute(
                """UPDATE users SET quota_used = ?, quota_period_start = ?
                   WHERE user_id = ?""",
                (new_used, period_start, user_id),
            )
            return {
                "used": new_used,
                "limit": limit,
                "remaining": max(0, limit - new_used),
                "period_start": period_start,
                "exceeded": new_used >= limit,
            }

        result = self._execute_write(_do)
        if result is None:
            raise UserStoreError(f"unknown user_id: {user_id}")
        return result

    # ── Write helper ───────────────────────────────────────────────────

    def _execute_write(self, fn):
        """Run ``fn(conn)`` inside BEGIN IMMEDIATE with jitter retry.

        ``fn`` may return a value (e.g. rowcount); it propagates back to
        the caller after COMMIT.  Mirrors :meth:`hermes_state.SessionDB.
        _execute_write` but simpler (no checkpoint scheduling — web_users
        is low-throughput).
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
