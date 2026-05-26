"""Tests for ``gateway.web.aux_byo_router``.

The patch installs into a global module attribute, so we restore the
original after each test to keep test ordering deterministic.
"""

from __future__ import annotations

import pytest

from agent import auxiliary_client as _aux
from gateway.web import aux_byo_router
from gateway.web.upstream_key import enter_upstream_key


@pytest.fixture(autouse=True)
def _restore_resolver_and_flag(monkeypatch):
    """Snapshot the original resolver + chain + try-* + install flag
    so each test starts clean (the install function is intentionally
    idempotent in production, but tests need to be able to re-install
    on a fresh state to verify install-time behaviour).
    """
    original_resolver = _aux._resolve_custom_runtime
    original_chain = _aux._get_provider_chain
    original_try_or = _aux._try_openrouter
    original_try_nous = _aux._try_nous
    original_flag = aux_byo_router._installed
    yield
    _aux._resolve_custom_runtime = original_resolver
    _aux._get_provider_chain = original_chain
    _aux._try_openrouter = original_try_or
    _aux._try_nous = original_try_nous
    aux_byo_router._installed = original_flag


def test_install_is_no_op_without_new_api_base_url(monkeypatch):
    """If NEW_API_BASE_URL is unset, the patched resolver must defer
    to the original implementation — operators who configure web_chat
    without BYO routing keep upstream behaviour.
    """
    monkeypatch.delenv("NEW_API_BASE_URL", raising=False)
    sentinel = ("https://orig.example.com", "orig-key", "anthropic_messages")
    monkeypatch.setattr(_aux, "_resolve_custom_runtime", lambda: sentinel)
    aux_byo_router._installed = False

    aux_byo_router.install_aux_byo_router()
    result = _aux._resolve_custom_runtime()

    assert result == sentinel


def test_install_returns_new_api_with_upstream_key(monkeypatch):
    """In BYO mode + inside a chat request (upstream key bound), the
    patched resolver returns the new-api gateway and the per-user key.
    """
    monkeypatch.setenv("NEW_API_BASE_URL", "https://gw.example.com")
    aux_byo_router._installed = False
    aux_byo_router.install_aux_byo_router()

    with enter_upstream_key("sk-user-key"):
        base, key, mode = _aux._resolve_custom_runtime()

    assert base == "https://gw.example.com/v1"
    assert key == "sk-user-key"
    assert mode == "chat_completions"


def test_install_returns_placeholder_when_no_request_context(monkeypatch):
    """In BYO mode but *outside* a request (e.g. background compression
    after disconnect), the resolver falls back to a placeholder rather
    than leaving the auxiliary chain credential-less.  The auxiliary
    call will likely 401 at the upstream — that's fine and is the
    intended signal that the work shouldn't have run anonymously.
    """
    monkeypatch.setenv("NEW_API_BASE_URL", "https://gw.example.com/v1")
    aux_byo_router._installed = False
    aux_byo_router.install_aux_byo_router()

    base, key, mode = _aux._resolve_custom_runtime()

    assert base == "https://gw.example.com/v1"
    # Placeholder — keeps the OpenAI SDK happy (it requires non-empty
    # api_key) without inventing fake credentials.
    assert key == "no-key-required"
    assert mode == "chat_completions"


def test_install_normalizes_trailing_v1(monkeypatch):
    """Operators may include /v1 in NEW_API_BASE_URL; the patched
    resolver must normalize so we don't end up with /v1/v1.
    """
    monkeypatch.setenv("NEW_API_BASE_URL", "https://gw.example.com/v1")
    aux_byo_router._installed = False
    aux_byo_router.install_aux_byo_router()

    base, _, _ = _aux._resolve_custom_runtime()
    assert base == "https://gw.example.com/v1"


def test_install_is_idempotent(monkeypatch):
    """Calling install twice must not double-wrap the resolver — that
    would leave the original buried under N layers of patches and
    impossible to restore cleanly.
    """
    monkeypatch.setenv("NEW_API_BASE_URL", "https://gw.example.com")
    aux_byo_router._installed = False

    aux_byo_router.install_aux_byo_router()
    first_patched = _aux._resolve_custom_runtime
    aux_byo_router.install_aux_byo_router()
    second_patched = _aux._resolve_custom_runtime

    assert first_patched is second_patched


# ── Patch 2: _get_provider_chain ──────────────────────────────────────────


def test_chain_excludes_openrouter_and_nous_in_byo_mode(monkeypatch):
    """The whole point of patch 2: BYO deployments don't want
    auxiliary callers walking into OpenRouter/Nous probes (which spam
    "marking unhealthy" warnings).  Chain in BYO mode must drop both
    while preserving the remaining entries (custom, api-key).
    """
    monkeypatch.setenv("NEW_API_BASE_URL", "https://gw.example.com")
    aux_byo_router._installed = False
    aux_byo_router.install_aux_byo_router()

    chain = _aux._get_provider_chain()
    labels = [label for (label, _fn) in chain]

    assert "openrouter" not in labels
    assert "nous" not in labels
    # Surviving labels must still be present so auxiliary callers can
    # actually find a backend.
    assert "local/custom" in labels
    assert "api-key" in labels


def test_chain_passthrough_without_new_api_base_url(monkeypatch):
    """If the operator hasn't configured BYO routing, the chain must
    pass through unchanged — non-BYO deployments still rely on the
    OpenRouter/Nous fallback behaviour the upstream provides.
    """
    monkeypatch.delenv("NEW_API_BASE_URL", raising=False)
    aux_byo_router._installed = False
    aux_byo_router.install_aux_byo_router()

    chain = _aux._get_provider_chain()
    labels = [label for (label, _fn) in chain]

    assert "openrouter" in labels
    assert "nous" in labels


# ── Patch 3: _try_openrouter / _try_nous direct-call short-circuit ────────


def test_try_openrouter_silent_in_byo_mode(monkeypatch):
    """The whole point of patch 3: callers that go straight to
    ``_try_openrouter`` (vision capability detection in particular —
    ``_VISION_AUTO_PROVIDER_ORDER`` walks them on every chat turn)
    bypass the chain.  In BYO mode they must return (None, None)
    without ever calling the original (which would mark unhealthy
    and emit a WARNING).
    """
    monkeypatch.setenv("NEW_API_BASE_URL", "https://gw.example.com")
    aux_byo_router._installed = False

    original_called = {"flag": False}

    def _spy(*a, **kw):
        original_called["flag"] = True
        return "would-be-client", "would-be-model"

    monkeypatch.setattr(_aux, "_try_openrouter", _spy)
    aux_byo_router.install_aux_byo_router()

    result = _aux._try_openrouter()
    assert result == (None, None)
    assert original_called["flag"] is False, (
        "BYO patch must NOT call the original _try_openrouter — "
        "doing so would re-emit the 'marking openrouter unhealthy' "
        "warning we're trying to silence."
    )


def test_try_nous_silent_in_byo_mode(monkeypatch):
    """Same as the openrouter test for the Nous backend."""
    monkeypatch.setenv("NEW_API_BASE_URL", "https://gw.example.com")
    aux_byo_router._installed = False

    original_called = {"flag": False}

    def _spy(*a, **kw):
        original_called["flag"] = True
        return "would-be-client", "would-be-model"

    monkeypatch.setattr(_aux, "_try_nous", _spy)
    aux_byo_router.install_aux_byo_router()

    result = _aux._try_nous()
    assert result == (None, None)
    assert original_called["flag"] is False


def test_try_openrouter_passthrough_without_new_api_base_url(monkeypatch):
    """Non-BYO deployments must keep upstream behaviour: the patched
    _try_openrouter should call straight through to the original.
    """
    monkeypatch.delenv("NEW_API_BASE_URL", raising=False)
    aux_byo_router._installed = False

    original_called = {"flag": False}

    def _spy(*a, **kw):
        original_called["flag"] = True
        return None, None

    monkeypatch.setattr(_aux, "_try_openrouter", _spy)
    aux_byo_router.install_aux_byo_router()

    _aux._try_openrouter()
    assert original_called["flag"] is True
