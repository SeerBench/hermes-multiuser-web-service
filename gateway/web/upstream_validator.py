"""Pre-flight validation of an end-user's upstream API key against new-api.

When a user logs in to ``web_chat`` by pasting their upstream key, we
ping the configured ``new-api`` (or any OpenAI-compatible) gateway with
``GET /v1/models`` carrying ``Authorization: Bearer <key>``.  This
gives the user immediate, deterministic feedback — invalid keys are
rejected at the login modal rather than at the next chat turn.

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


async def validate_key_against_upstream(
    api_key: str,
    base_url: str,
    *,
    timeout_seconds: float = _VALIDATE_TIMEOUT_SECONDS,
    path: str = "/v1/models",
) -> ValidationResult:
    """Probe ``{base_url}{path}`` with ``api_key`` and classify the response.

    ``base_url`` is expected to be the value of ``NEW_API_BASE_URL`` —
    i.e. the operator's upstream gateway root, without a trailing slash
    and without ``/v1/...``.  Trailing slashes are stripped to be safe.

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

    url = base_url.rstrip("/") + path
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
    }
    timeout = aiohttp.ClientTimeout(total=timeout_seconds)

    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, headers=headers) as resp:
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
                # Remaining 4xx (400, 404, 405, …) → base_url or path is
                # wrong; operator's fault, not the user's.
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
