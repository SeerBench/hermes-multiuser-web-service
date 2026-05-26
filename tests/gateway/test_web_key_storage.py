"""Tests for ``gateway.web.key_storage.KeyVault``.

Covers:
- Fernet encrypt/decrypt round-trip.
- Master-key file is created on first instantiation with mode 0600.
- A second KeyVault pointed at the same master key file decrypts the
  first one's ciphertext (i.e. the file, not memory, is the source of
  truth).
- Tampered ciphertext is rejected with :class:`KeyVaultError`.
"""

import os
import stat

import pytest

from gateway.web.key_storage import KeyVault, KeyVaultError


# ── Round-trip ─────────────────────────────────────────────────────────────


def test_encrypt_then_decrypt_recovers_plaintext(tmp_path):
    vault = KeyVault(master_key_path=tmp_path / "master.key")
    ct = vault.encrypt("sk-very-secret-12345")
    assert ct != "sk-very-secret-12345"  # actually encrypted
    assert vault.decrypt(ct) == "sk-very-secret-12345"


def test_encrypt_is_nondeterministic(tmp_path):
    """Same plaintext, two calls → two different ciphertexts (Fernet's
    fresh nonce).  Catches accidental ECB-style use.
    """
    vault = KeyVault(master_key_path=tmp_path / "master.key")
    a = vault.encrypt("sk-same")
    b = vault.encrypt("sk-same")
    assert a != b
    assert vault.decrypt(a) == vault.decrypt(b) == "sk-same"


def test_unicode_roundtrip(tmp_path):
    """Keys come in as Python str; make sure non-ASCII content survives."""
    vault = KeyVault(master_key_path=tmp_path / "master.key")
    payload = "sk-ünïcödë-✨"
    assert vault.decrypt(vault.encrypt(payload)) == payload


# ── Master-key file management ─────────────────────────────────────────────


def test_master_key_file_created_with_0600_permissions(tmp_path):
    key_path = tmp_path / "master.key"
    assert not key_path.exists()
    KeyVault(master_key_path=key_path)
    assert key_path.is_file()
    mode = stat.S_IMODE(key_path.stat().st_mode)
    # On Windows the permission bits don't carry the same meaning,
    # so we skip the assertion there.
    if os.name == "posix":
        assert mode == 0o600, f"expected mode 0o600, got {oct(mode)}"


def test_master_key_file_is_reused_on_second_construction(tmp_path):
    key_path = tmp_path / "master.key"
    vault1 = KeyVault(master_key_path=key_path)
    ct = vault1.encrypt("sk-persist-me")
    # Construct a fresh vault → must use the same on-disk key.
    vault2 = KeyVault(master_key_path=key_path)
    assert vault2.decrypt(ct) == "sk-persist-me"


def test_master_key_file_contents_unchanged_on_reload(tmp_path):
    key_path = tmp_path / "master.key"
    KeyVault(master_key_path=key_path)
    before = key_path.read_bytes()
    KeyVault(master_key_path=key_path)
    after = key_path.read_bytes()
    assert before == after


def test_parent_directory_is_created_if_missing(tmp_path):
    """KeyVault is constructed against ``$HERMES_HOME/web_users_master.key``
    which may not exist on first start; the constructor mkdir's it.
    """
    deep_path = tmp_path / "nested" / "dir" / "master.key"
    assert not deep_path.parent.exists()
    KeyVault(master_key_path=deep_path)
    assert deep_path.is_file()


# ── Tampering / wrong key rejection ────────────────────────────────────────


def test_tampered_ciphertext_raises_key_vault_error(tmp_path):
    vault = KeyVault(master_key_path=tmp_path / "master.key")
    ct = vault.encrypt("sk-original")
    # Flip a character in the middle — keeps base64 shape but corrupts MAC.
    tampered = ct[:20] + ("A" if ct[20] != "A" else "B") + ct[21:]
    with pytest.raises(KeyVaultError):
        vault.decrypt(tampered)


def test_different_master_keys_cannot_decrypt_each_others_ciphertext(tmp_path):
    """A new master key file invalidates every prior session row — the
    intended behavior when operators regenerate the secret.
    """
    vault_a = KeyVault(master_key_path=tmp_path / "a.key")
    ct = vault_a.encrypt("sk-belongs-to-a")
    vault_b = KeyVault(master_key_path=tmp_path / "b.key")
    with pytest.raises(KeyVaultError):
        vault_b.decrypt(ct)


def test_empty_master_key_file_raises(tmp_path):
    """If the file exists but is empty, refuse to silently regenerate —
    that would mask a half-written write or a deployment bug.
    """
    empty = tmp_path / "master.key"
    empty.write_bytes(b"")
    with pytest.raises(KeyVaultError):
        KeyVault(master_key_path=empty)


# ── Type validation ────────────────────────────────────────────────────────


def test_encrypt_rejects_non_string(tmp_path):
    vault = KeyVault(master_key_path=tmp_path / "master.key")
    with pytest.raises(TypeError):
        vault.encrypt(b"bytes-not-str")  # type: ignore[arg-type]


def test_decrypt_rejects_non_string(tmp_path):
    vault = KeyVault(master_key_path=tmp_path / "master.key")
    with pytest.raises(TypeError):
        vault.decrypt(b"bytes-not-str")  # type: ignore[arg-type]
