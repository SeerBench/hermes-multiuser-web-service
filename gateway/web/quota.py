"""Per-user token quota enforcement for ``web_chat``.

Wraps :meth:`gateway.web.users.UserStore.add_usage` with HTTP semantics:

- :meth:`QuotaGate.preflight` is called **before** the AIAgent loop runs.
  It rolls the user's 30-day window if it has elapsed (via
  ``add_usage(user_id, 0)``) and raises :class:`aiohttp.web.
  HTTPTooManyRequests` if the user is already over-quota.

- :meth:`QuotaGate.record` is called **after** the agent finishes (in a
  ``finally`` block so a streaming abort still records partial usage).
  It adds the consumed tokens and returns the new state.

Both responses include ``X-Quota-Used`` / ``X-Quota-Limit`` /
``X-Quota-Remaining`` headers so SPA can render the meter without a
separate ``/api/usage`` poll.

Design notes
------------
- The 30-day window rolls automatically inside ``UserStore.add_usage`` —
  ``preflight`` does not need to special-case "window expired".
- ``record(0)`` is safe and used for the "streaming abort before any
  tokens were produced" path.
- This module is intentionally *not* an aiohttp middleware.  Quota only
  applies to the chat endpoint(s) — login, key management, conversation
  listing etc. are free.  The chat handler imports ``QuotaGate``
  directly.
"""

from __future__ import annotations

import logging
from typing import Any, Dict

from aiohttp import web

from gateway.web.users import UserStore, UserStoreError

logger = logging.getLogger("hermes.web.quota")


def _quota_headers(state: Dict[str, Any]) -> Dict[str, str]:
    return {
        "X-Quota-Used": str(state["used"]),
        "X-Quota-Limit": str(state["limit"]),
        "X-Quota-Remaining": str(state["remaining"]),
    }


class QuotaGate:
    """HTTP-aware wrapper around UserStore quota operations."""

    def __init__(self, store: UserStore):
        self._store = store

    def preflight(self, user_id: str) -> Dict[str, Any]:
        """Side-effect: roll the user's 30-day window if elapsed.

        Returns the current quota state.  Raises :class:`HTTPTooManyRequests`
        if the user is already over-quota.  Raises :class:`HTTPNotFound`
        for an unknown user — but in practice the auth middleware
        guarantees the user exists, so we treat this as a 500-class bug
        in the caller.
        """
        try:
            state = self._store.add_usage(user_id, 0)
        except UserStoreError as exc:
            logger.error("quota preflight for unknown user_id %r: %s", user_id, exc)
            raise web.HTTPInternalServerError(reason="user_not_found") from exc

        if state["exceeded"]:
            raise web.HTTPTooManyRequests(
                reason="quota_exceeded",
                headers=_quota_headers(state),
            )
        return state

    def record(self, user_id: str, tokens: int) -> Dict[str, Any]:
        """Add ``tokens`` to ``user_id``'s usage.  Returns post-update state.

        Does NOT raise on over-quota — the agent already ran, we record
        the truth.  Future requests' preflight will then 429.
        ``tokens=0`` is allowed (no-op increment) so streaming aborts
        can call ``record`` unconditionally.
        """
        try:
            return self._store.add_usage(user_id, tokens)
        except UserStoreError:
            logger.exception("quota record failed for user_id=%s tokens=%s", user_id, tokens)
            # Don't surface to the user — recording is best-effort.
            return {
                "used": -1,
                "limit": -1,
                "remaining": -1,
                "period_start": 0.0,
                "exceeded": False,
            }


def attach_quota_headers(response: web.StreamResponse, state: Dict[str, Any]) -> None:
    """Merge quota headers onto an existing response.

    Useful for the success path of chat / completions, where the response
    is built in-handler.
    """
    for k, v in _quota_headers(state).items():
        response.headers[k] = v
