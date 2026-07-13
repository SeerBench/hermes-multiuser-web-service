"""Pre-flight validation of an end-user's upstream API key against new-api.

When a user logs in to ``web_chat`` by pasting their upstream key, we
ping the configured ``new-api`` (or any OpenAI-compatible) gateway and
classify the response.  This gives the user immediate, deterministic
feedback — invalid keys are rejected at the login modal rather than at
the next chat turn.

Two probe modes are supported:

- ``probe_model="<name>"``  — POST ``/v1/chat/completions`` with the
                              smallest possible request (``max_tokens=1``,
                              one short user message).  This is the
                              accurate path: it exercises the same code
                              path the chat handler does, so a key that
                              ``/v1/models`` accepts but chat rejects
                              (a real-world new-api configuration, where
                              the models list is unauthenticated but
                              chat strictly checks the token) is caught
                              at login.  Costs a couple of tokens per
                              login — fractions of a cent.
- ``probe_model=None``      — GET ``/v1/models``.  No token cost, but
                              can be misled by gateways that don't
                              authenticate the models endpoint.  Kept
                              as a fallback for operators who can't
                              afford the few-token chat probe, and for
                              the case where the gateway's default
                              model name can't be resolved at login time.

Outcomes we distinguish:

- ``valid``        — 2xx response, the gateway accepted the key.
- ``invalid_key``  — 401 / 403, the gateway rejected the key.
- ``upstream_unreachable`` — network error, DNS failure, timeout, or
                              a 5xx / 429 — the gateway is misconfigured
                              or temporarily unhealthy.  We do NOT reject
                              the login on this — the operator's gateway
                              hiccupping should not lock users out.
                              In practice the chat handler chooses
                              whether to issue a session anyway or to
                              return a "try again" error to the SPA.

The validator is a thin wrapper over :mod:`aiohttp` (which the web_chat
platform already depends on).  No retries: the SPA's "Login" button is
a natural retry surface, and adding internal retries would make a flaky
gateway feel slower than it actually is.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

try:
    import aiohttp
    _AIOHTTP_AVAILABLE = True
except ImportError:  # pragma: no cover — aiohttp is part of [web-chat]
    aiohttp = None  # type: ignore[assignment]
    _AIOHTTP_AVAILABLE = False

logger = logging.getLogger("hermes.web.upstream_validator")

# Total budget for the validation request.  10s is generous for a
# /v1/models call that typically returns in <200ms; we want to ride
# out a transient cold-start without blocking the login forever.
_VALIDATE_TIMEOUT_SECONDS = 10.0


@dataclass(frozen=True)
class ValidationResult:
    """Outcome of one ``validate_key_against_upstream`` call.

    Attributes:
        valid: True iff the upstream gateway accepted the key.
        error_code: Stable token the SPA can map to a localized string.
            One of ``invalid_key`` / ``upstream_unreachable`` /
            ``misconfigured`` / ``None`` (when ``valid`` is True).
        error_msg: Human-readable hint for the operator's logs.  Not
            shown to end-users — the SPA maps ``error_code`` to its own
            messages.
        status: HTTP status code observed from the gateway, or None on
            transport-layer errors.  Surfaced for diagnostic logging.
    """

    valid: bool
    error_code: Optional[str] = None
    error_msg: Optional[str] = None
    status: Optional[int] = None


def validate_key_against_upstream_sync(
    api_key: str,
    base_url: str,
    *,
    probe_model: Optional[str] = None,
    timeout_seconds: float = _VALIDATE_TIMEOUT_SECONDS,
    path: str = "/v1/models",
) -> ValidationResult:
    """Synchronous wrapper for bind-key and other sync call sites."""
    import asyncio
    import concurrent.futures

    coro = validate_key_against_upstream(
        api_key,
        base_url,
        probe_model=probe_model,
        timeout_seconds=timeout_seconds,
        path=path,
    )
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


async def validate_key_against_upstream(
    api_key: str,
    base_url: str,
    *,
    probe_model: Optional[str] = None,
    timeout_seconds: float = _VALIDATE_TIMEOUT_SECONDS,
    path: str = "/v1/models",
) -> ValidationResult:
    """Probe the upstream with ``api_key`` and classify the response.

    ``base_url`` is expected to be the value of ``NEW_API_BASE_URL`` —
    i.e. the operator's upstream gateway root.  Trailing slashes and a
    trailing ``/v1`` segment are both tolerated via
    :func:`gateway.web.upstream_key.normalize_new_api_base_url`.

    When ``probe_model`` is given, the validator POSTs a minimal
    ``/v1/chat/completions`` request (``max_tokens=1``, one short user
    message) so the probe exercises the same authentication code path
    the chat handler will hit.  This is the recommended mode — it
    catches new-api gateways whose ``/v1/models`` is unauthenticated
    but whose chat endpoint strictly validates the token.

    When ``probe_model`` is ``None``, the validator falls back to
    ``GET /v1/models`` — preserved for backwards compatibility, for
    operators who don't want the few-token probe cost, and for the
    edge case where ``_resolve_gateway_model()`` returns an empty
    string and the caller has no model name to supply.

    The function never raises for transport errors — they are reported
    via the ``ValidationResult``.  Caller is responsible for whether to
    treat ``upstream_unreachable`` as a hard reject or as a soft
    accept-with-warning (the chat handler treats it as hard reject so
    the user gets a clear error rather than a silent failure later).

    Tests can monkey-patch ``aiohttp.ClientSession`` to inject fake
    responses; in production we use the real session per call (no
    connection pool — login is rare and the cost of building a new
    session is negligible compared to the network round-trip).
    """
    if not _AIOHTTP_AVAILABLE:
        return ValidationResult(
            valid=False,
            error_code="misconfigured",
            error_msg="aiohttp not installed — install the [web-chat] extra",
        )
    if not api_key or not api_key.strip():
        return ValidationResult(
            valid=False,
            error_code="invalid_key",
            error_msg="empty api_key",
        )
    if not base_url or not base_url.strip():
        return ValidationResult(
            valid=False,
            error_code="misconfigured",
            error_msg="NEW_API_BASE_URL is not configured on the server",
        )

    # Accept both forms operators commonly configure
    # (``https://gateway.example.com`` *and*
    # ``https://gateway.example.com/v1``) by stripping a trailing ``/v1``
    # before re-appending the probe path.  See
    # ``gateway.web.upstream_key.normalize_new_api_base_url`` for the
    # rationale — the chat path needs the ``/v1`` baked in, the
    # validator needs to hit ``/v1/...`` exactly once.
    from gateway.web.upstream_key import normalize_new_api_base_url

    base = normalize_new_api_base_url(base_url)
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
    }
    timeout = aiohttp.ClientTimeout(total=timeout_seconds)

    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            if probe_model:
                url = base + "/v1/chat/completions"
                body = {
                    "model": probe_model,
                    "messages": [{"role": "user", "content": "hi"}],
                    "max_tokens": 1,
                    # ``stream=False`` is the default but spell it out
                    # so a server that requires the field doesn't reject
                    # the probe for the wrong reason.
                    "stream": False,
                }
                ctx = session.post(url, headers=headers, json=body)
            else:
                url = base + path
                ctx = session.get(url, headers=headers)

            async with ctx as resp:
                status = resp.status
                if 200 <= status < 300:
                    return ValidationResult(valid=True, status=status)
                if status in (401, 403):
                    return ValidationResult(
                        valid=False,
                        error_code="invalid_key",
                        error_msg=f"upstream rejected key (HTTP {status})",
                        status=status,
                    )
                # 429 is rate-limit — upstream is up but throttling.  Bucket
                # it with 5xx ("try again later") rather than with the
                # operator-misconfiguration 4xx codes.
                if status == 429 or 500 <= status < 600:
                    return ValidationResult(
                        valid=False,
                        error_code="upstream_unreachable",
                        error_msg=f"upstream returned {status}",
                        status=status,
                    )
                # Remaining 4xx (400, 404, 405, …) → base_url is wrong,
                # the model name is wrong, or the request body shape
                # mismatched the gateway's expectations.  All of these
                # are operator-side, not end-user-side.
                return ValidationResult(
                    valid=False,
                    error_code="misconfigured",
                    error_msg=f"unexpected client-error from upstream (HTTP {status})",
                    status=status,
                )
    except Exception as exc:  # noqa: BLE001 — any failure on a network op is "unreachable"
        # We deliberately collapse every non-HTTP-status failure mode
        # (DNS, TCP refused, TLS, timeout, malformed response) into
        # ``upstream_unreachable`` — the SPA shows the same "try again"
        # message regardless.  ``str(exc)`` is wrapped in a try/except
        # because some aiohttp exception subclasses raise from their own
        # __str__ when constructed in unusual ways (e.g. the test suite).
        try:
            detail = f"{type(exc).__name__}: {exc}"
        except Exception:
            detail = type(exc).__name__
        logger.warning("upstream validation failed: %s", detail)
        return ValidationResult(
            valid=False,
            error_code="upstream_unreachable",
            error_msg=detail,
        )
