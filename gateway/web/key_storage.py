"""Symmetric encryption for end-user upstream API keys.

The web_chat platform persists each logged-in user's upstream API key
in ``web_users.web_sessions.api_key_enc`` so the SPA's cookie alone is
sufficient to authenticate subsequent chat requests (no need to ask
the user for the key on every browser restart).  Because that key is
the user's billable credential against ``new-api`` — leaking it would
let an attacker spend the user's quota — we encrypt at rest.

Design choices
--------------
- **Fernet (AES-128-CBC + HMAC-SHA256)** via :mod:`cryptography.fernet`.
  Reuses a library that the gateway already pulls transitively (PyJWT
  → cryptography); it's the standard "symmetric envelope with
  authenticated encryption" primitive in Python and not worth replacing
  with something fancier here.
- **Master key file** at ``$HERMES_HOME/web_users_master.key`` (next to
  ``web_users.db``).  Generated once at first start, kept ``chmod 600``,
  treated as a co-equal secret with the database — backing one up
  without the other is useless.
- **Defense in depth**: an attacker who exfiltrates only the database
  (e.g. via a backup copy) gets ciphertext blobs they can't use.  An
  attacker who exfiltrates only the master key has nothing to decrypt.
  Compromising both is functionally equivalent to compromising the
  upstream credentials directly.
- **Key rotation** is out of scope for v1.  Rotating means re-encrypting
  every row (or invalidating every session); we'll add a CLI for it if
  a real rotation event happens.  Documented in :mod:`docs/user-guide/
  web-chat.md`.

Tests can pass a custom ``master_key_path`` to :class:`KeyVault` to keep
master keys out of ``$HERMES_HOME`` during the suite.
"""

from __future__ import annotations

import logging
import os
import stat
from pathlib import Path
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken

from hermes_constants import get_hermes_home

logger = logging.getLogger("hermes.web.key_storage")

_DEFAULT_MASTER_KEY_FILENAME = "web_users_master.key"
_MASTER_KEY_MODE = 0o600  # owner read+write only


class KeyVaultError(RuntimeError):
    """Raised for permanent encryption / decryption failures.

    Transient I/O issues on the master-key file (e.g. concurrent
    creation) are retried internally — callers only see this exception
    when the failure mode is "the configuration is broken and a human
    needs to look at it".
    """


class KeyVault:
    """Symmetric encrypt / decrypt helper backed by a Fernet master key.

    Construction is cheap and side-effect free unless the master key
    file is missing, in which case it is created with ``chmod 600``
    on first instantiation.  In typical usage the web_chat platform
    constructs one KeyVault at gateway startup and shares it across all
    requests.
    """

    def __init__(self, master_key_path: Optional[Path] = None):
        if master_key_path is None:
            master_key_path = get_hermes_home() / _DEFAULT_MASTER_KEY_FILENAME
        self._master_key_path = Path(master_key_path)
        self._fernet = Fernet(self._load_or_create_master_key())

    # ── Master-key file management ─────────────────────────────────────

    def _load_or_create_master_key(self) -> bytes:
        """Read the master key file; create it on first use.

        Reads the existing file when present (without overwriting), or
        generates a fresh 32-byte Fernet key, writes it atomically with
        ``chmod 600``, and returns it.  The atomic write uses
        ``os.open(..., O_CREAT | O_EXCL)`` so a race between two gateway
        instances ends with one of them losing the write and reading the
        winner's file on retry.
        """
        path = self._master_key_path
        path.parent.mkdir(parents=True, exist_ok=True)

        # Fast path: file already exists.
        if path.is_file():
            return self._read_master_key_file(path)

        # Slow path: create atomically.  Generate a candidate key but
        # only commit it if O_EXCL succeeds; otherwise re-read.
        candidate = Fernet.generate_key()
        try:
            fd = os.open(
                str(path),
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                _MASTER_KEY_MODE,
            )
        except FileExistsError:
            # Lost the race — read the winner's value.
            return self._read_master_key_file(path)
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(candidate)
        except Exception:
            # Cleanup half-written file so retries don't read garbage.
            try:
                path.unlink()
            except OSError:
                pass
            raise
        # Belt-and-suspenders: O_CREAT honors mode but umask can still
        # mask bits; force the mode explicitly so the file is reliably
        # 600 even on systems with a permissive default umask.
        try:
            os.chmod(str(path), _MASTER_KEY_MODE)
        except OSError:
            logger.warning(
                "could not chmod master key file %s to 0600 — "
                "file permissions may be wider than intended", path,
            )
        logger.info("generated web_chat master key at %s", path)
        return candidate

    @staticmethod
    def _read_master_key_file(path: Path) -> bytes:
        try:
            data = path.read_bytes()
        except OSError as exc:
            raise KeyVaultError(
                f"could not read web_chat master key file {path}: {exc}"
            ) from exc
        if not data:
            raise KeyVaultError(
                f"web_chat master key file {path} is empty — delete it to regenerate"
            )
        # Sanity-check permissions; warn but don't fail.  Containers and
        # bind-mounts sometimes show 644 even when the host file is 600.
        try:
            mode = stat.S_IMODE(path.stat().st_mode)
            if mode & 0o077:
                logger.warning(
                    "web_chat master key file %s has loose permissions (mode=%o); "
                    "should be 0600",
                    path, mode,
                )
        except OSError:
            pass
        return data

    # ── Encrypt / decrypt ──────────────────────────────────────────────

    def encrypt(self, plaintext: str) -> str:
        """Return an ASCII-safe ciphertext for storage in a TEXT column.

        Fernet tokens are already URL-safe base64; we return them as
        ``str`` so they round-trip cleanly through SQLite without binary
        handling concerns.
        """
        if not isinstance(plaintext, str):
            raise TypeError("plaintext must be a str")
        token = self._fernet.encrypt(plaintext.encode("utf-8"))
        return token.decode("ascii")

    def decrypt(self, ciphertext: str) -> str:
        """Decrypt a string previously returned by :meth:`encrypt`.

        Raises :class:`KeyVaultError` on tampering / wrong key / corrupt
        ciphertext.  Callers should treat that as "session row is
        unusable" and force the user to log in again rather than as a
        crash — the most common cause in production is "operator
        regenerated the master key", which simply invalidates every
        existing session.
        """
        if not isinstance(ciphertext, str):
            raise TypeError("ciphertext must be a str")
        try:
            return self._fernet.decrypt(ciphertext.encode("ascii")).decode("utf-8")
        except InvalidToken as exc:
            raise KeyVaultError(
                "ciphertext failed authentication — master key changed "
                "or row was tampered with"
            ) from exc
