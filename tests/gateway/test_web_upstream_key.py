"""Tests for ``gateway.web.upstream_key``.

Covers the per-request upstream API key ContextVar and the
``derive_user_id`` helper that maps a key to a stable workspace
identifier.
"""

import asyncio
import hashlib

import pytest

from gateway.web.upstream_key import (
    derive_user_id,
    enter_upstream_key,
    get_upstream_key,
)


# ── derive_user_id ─────────────────────────────────────────────────────────


def test_derive_user_id_is_deterministic_across_calls():
    a = derive_user_id("sk-test-abcdef123456")
    b = derive_user_id("sk-test-abcdef123456")
    assert a == b


def test_derive_user_id_differs_for_different_keys():
    assert derive_user_id("sk-test-aaa") != derive_user_id("sk-test-bbb")


def test_derive_user_id_has_legacy_compatible_format():
    """``u_<12hex>`` so workspace dirs and SessionDB rows interoperate
    with anything that read the legacy UserStore-minted ids.
    """
    uid = derive_user_id("sk-test-xyz")
    assert uid.startswith("u_")
    assert len(uid) == 2 + 12
    hex_part = uid[2:]
    int(hex_part, 16)  # raises if not valid hex


def test_derive_user_id_matches_sha256_prefix():
    """Be explicit about the algorithm — anyone migrating data across a
    rename / reorg can reproduce the mapping with a single sha256 call.
    """
    key = "hello-world"
    expected = "u_" + hashlib.sha256(key.encode()).hexdigest()[:12]
    assert derive_user_id(key) == expected


def test_derive_user_id_rejects_empty_string():
    with pytest.raises(ValueError):
        derive_user_id("")


def test_derive_user_id_rejects_whitespace_only():
    with pytest.raises(ValueError):
        derive_user_id("   ")


# ── enter_upstream_key / get_upstream_key ──────────────────────────────────


def test_default_is_none_outside_context():
    assert get_upstream_key() is None


def test_enter_binds_key_inside_block():
    with enter_upstream_key("sk-inside"):
        assert get_upstream_key() == "sk-inside"


def test_enter_resets_key_on_exit():
    with enter_upstream_key("sk-inside"):
        pass
    assert get_upstream_key() is None


def test_enter_with_none_does_not_bind():
    """Calling sites that conditionally have a key pass through None
    without changing the contextvar — the with-block becomes a no-op.
    """
    with enter_upstream_key(None):
        assert get_upstream_key() is None


def test_enter_nesting_restores_outer_value():
    with enter_upstream_key("outer"):
        assert get_upstream_key() == "outer"
        with enter_upstream_key("inner"):
            assert get_upstream_key() == "inner"
        assert get_upstream_key() == "outer"
    assert get_upstream_key() is None


def test_enter_resets_even_when_body_raises():
    with pytest.raises(RuntimeError):
        with enter_upstream_key("sk-explode"):
            assert get_upstream_key() == "sk-explode"
            raise RuntimeError("boom")
    assert get_upstream_key() is None


def test_contextvar_propagates_to_asyncio_task():
    """ContextVar copy-on-spawn means tasks/threads created inside the
    enter_upstream_key block see the bound key.  This is the load-bearing
    property that lets chat_runner._create_agent read the key from a
    worker thread.
    """

    async def _scenario():
        with enter_upstream_key("sk-propagate"):
            async def _inner():
                return get_upstream_key()

            return await asyncio.create_task(_inner())

    result = asyncio.run(_scenario())
    assert result == "sk-propagate"
