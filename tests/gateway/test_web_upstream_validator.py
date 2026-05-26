"""Tests for ``gateway.web.upstream_validator``.

Covers the pre-login key validation call: success / invalid / network
unreachable / misconfigured paths.  ``aiohttp.ClientSession`` is faked
out so the tests neither talk to the network nor depend on a real
new-api instance.
"""

from typing import Any, Optional

import pytest

import gateway.web.upstream_validator as validator_module
from gateway.web.upstream_validator import (
    ValidationResult,
    validate_key_against_upstream,
)


# ── Test doubles for aiohttp ───────────────────────────────────────────────


class _FakeResp:
    """Async-context-manager response stub.

    ``payload`` may be either an ``int`` (returned as HTTP status) or an
    exception instance which will be raised on ``__aenter__`` to model
    transport-layer failures.
    """

    def __init__(self, payload):
        self._payload = payload
        self.status = payload if isinstance(payload, int) else None

    async def __aenter__(self):
        if isinstance(self._payload, BaseException):
            raise self._payload
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _FakeSession:
    """Captures the URL + headers it was called with so tests can assert
    on what the validator actually sent.
    """

    def __init__(self, response_payload):
        self._response_payload = response_payload
        self.last_url: Optional[str] = None
        self.last_headers: Optional[dict] = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def get(self, url, headers=None):
        self.last_url = url
        self.last_headers = dict(headers or {})
        return _FakeResp(self._response_payload)


def _install_fake_session(monkeypatch, payload) -> _FakeSession:
    """Patch ``aiohttp.ClientSession`` in the validator module so a
    single GET returns ``payload`` and return the spy session for
    assertions.
    """
    session = _FakeSession(payload)

    def _factory(*args, **kwargs):
        return session

    monkeypatch.setattr(validator_module.aiohttp, "ClientSession", _factory)
    return session


# ── 200 OK ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_valid_key_returns_valid_true(monkeypatch):
    _install_fake_session(monkeypatch, 200)
    result = await validate_key_against_upstream("sk-good", "https://api.example.com")
    assert result.valid is True
    assert result.status == 200
    assert result.error_code is None


@pytest.mark.asyncio
async def test_valid_2xx_range_all_pass(monkeypatch):
    """Non-200 success codes (201, 204, etc.) are still treated as valid."""
    for status in (200, 201, 204, 299):
        _install_fake_session(monkeypatch, status)
        result = await validate_key_against_upstream("sk-good", "https://api.example.com")
        assert result.valid is True, f"status {status} should be valid"


@pytest.mark.asyncio
async def test_get_targets_v1_models_with_bearer_header(monkeypatch):
    session = _install_fake_session(monkeypatch, 200)
    await validate_key_against_upstream("sk-good", "https://api.example.com")
    assert session.last_url == "https://api.example.com/v1/models"
    assert session.last_headers["Authorization"] == "Bearer sk-good"


@pytest.mark.asyncio
async def test_trailing_slash_in_base_url_is_stripped(monkeypatch):
    session = _install_fake_session(monkeypatch, 200)
    await validate_key_against_upstream("sk-good", "https://api.example.com/")
    assert session.last_url == "https://api.example.com/v1/models"


# ── 401 / 403 — invalid key ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_401_classified_as_invalid_key(monkeypatch):
    _install_fake_session(monkeypatch, 401)
    result = await validate_key_against_upstream("sk-bad", "https://api.example.com")
    assert result.valid is False
    assert result.error_code == "invalid_key"
    assert result.status == 401


@pytest.mark.asyncio
async def test_403_classified_as_invalid_key(monkeypatch):
    _install_fake_session(monkeypatch, 403)
    result = await validate_key_against_upstream("sk-bad", "https://api.example.com")
    assert result.valid is False
    assert result.error_code == "invalid_key"


# ── 4xx other — misconfigured ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_404_classified_as_misconfigured(monkeypatch):
    """404 means the path/host is wrong — operator's fault, not user's."""
    _install_fake_session(monkeypatch, 404)
    result = await validate_key_against_upstream("sk-good", "https://api.example.com")
    assert result.valid is False
    assert result.error_code == "misconfigured"


# ── 5xx / 429 — upstream unreachable ────────────────────────────────────────


@pytest.mark.asyncio
async def test_500_classified_as_upstream_unreachable(monkeypatch):
    _install_fake_session(monkeypatch, 500)
    result = await validate_key_against_upstream("sk-good", "https://api.example.com")
    assert result.valid is False
    assert result.error_code == "upstream_unreachable"
    assert result.status == 500


@pytest.mark.asyncio
async def test_429_classified_as_upstream_unreachable(monkeypatch):
    _install_fake_session(monkeypatch, 429)
    result = await validate_key_against_upstream("sk-good", "https://api.example.com")
    assert result.valid is False
    assert result.error_code == "upstream_unreachable"


# ── Transport-layer errors ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_aiohttp_client_error_classified_as_unreachable(monkeypatch):
    """Any aiohttp.ClientError subclass (DNS, TCP refused, TLS, etc.)
    collapses to ``upstream_unreachable``.  We use the base class here
    because its concrete subclasses each require non-trivial constructor
    arguments — what matters is the classification, not the subclass.
    """
    import aiohttp

    _install_fake_session(monkeypatch, aiohttp.ClientError("dns failure"))
    result = await validate_key_against_upstream("sk-good", "https://nowhere.invalid")
    assert result.valid is False
    assert result.error_code == "upstream_unreachable"


@pytest.mark.asyncio
async def test_timeout_classified_as_unreachable(monkeypatch):
    import asyncio

    _install_fake_session(monkeypatch, asyncio.TimeoutError())
    result = await validate_key_against_upstream("sk-good", "https://api.example.com")
    assert result.valid is False
    assert result.error_code == "upstream_unreachable"


@pytest.mark.asyncio
async def test_generic_exception_classified_as_unreachable(monkeypatch):
    _install_fake_session(monkeypatch, RuntimeError("unexpected network thing"))
    result = await validate_key_against_upstream("sk-good", "https://api.example.com")
    assert result.valid is False
    assert result.error_code == "upstream_unreachable"


# ── Argument validation ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_empty_key_rejected_without_network(monkeypatch):
    """Don't waste a round-trip — and don't accidentally probe with no
    Authorization header.
    """
    called = {"flag": False}

    def _factory(*a, **kw):
        called["flag"] = True
        return _FakeSession(200)

    monkeypatch.setattr(validator_module.aiohttp, "ClientSession", _factory)
    result = await validate_key_against_upstream("", "https://api.example.com")
    assert result.valid is False
    assert result.error_code == "invalid_key"
    assert called["flag"] is False


@pytest.mark.asyncio
async def test_empty_base_url_returns_misconfigured(monkeypatch):
    """Operator hasn't set NEW_API_BASE_URL — surface that distinctly so
    the SPA can render an operator-not-user error.
    """
    result = await validate_key_against_upstream("sk-good", "")
    assert result.valid is False
    assert result.error_code == "misconfigured"
