"""Per-request upstream API key binding for ``web_chat``.

When the web_chat platform integrates with an external billing gateway
(``new-api`` / QuantumNous-style OpenAI-compatible aggregator), every
end-user supplies their own upstream API key.  That key — not a shared
admin key — is what hermes uses when calling the LLM, so per-user usage
is attributed and billed correctly.

This module provides the ContextVar plumbing that carries the user's
upstream key from the HTTP handler down to ``AIAgent`` instantiation.
It mirrors :mod:`gateway.web.sandbox` (which carries the per-request
workspace).  Both rely on the fact that ``asyncio.loop.run_in_executor``
copies the current ContextVar context into the worker thread, so the
key is available to the agent factory without any explicit passing.

Public surface:

- :data:`_UPSTREAM_API_KEY` — the ContextVar (do not read directly,
  use :func:`get_upstream_key`).
- :func:`get_upstream_key` — read the active key, or ``None`` outside a
  request.
- :func:`enter_upstream_key` — context manager that binds the key on
  enter and resets on exit.
- :func:`derive_user_id` — stable user identifier from an upstream key
  (sha256-prefix), used to keep workspace / session history bound to
  the key rather than to a separate web_chat account.

The key itself never appears in logs.  Callers receive it from
:func:`gateway.web.auth.get_request_upstream_key` (which decrypts the
session row) and feed it into :func:`enter_upstream_key`; the agent
factory in :mod:`gateway.web.chat_runner` reads it back via
:func:`get_upstream_key` at the point it builds the OpenAI client.
"""

from __future__ import annotations

import hashlib
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator, Optional

_USER_ID_PREFIX = "u_"
_USER_ID_HASH_LEN = 12  # bytes of sha256 hex consumed — keep aligned with
                       # legacy ``u_<12hex>`` format produced by
                       # ``UserStore._new_user_id`` so existing workspace
                       # directories remain interpretable.

_UPSTREAM_API_KEY: ContextVar[Optional[str]] = ContextVar(
    "_UPSTREAM_API_KEY", default=None
)


def get_upstream_key() -> Optional[str]:
    """Return the active upstream API key, or ``None`` outside a request.

    Called by :class:`gateway.web.chat_runner.WebChatAgentRunner` when
    building the AIAgent kwargs — if the value is set, it overrides the
    globally-configured ``api_key`` so the upstream call is billed to
    the right end-user.
    """
    return _UPSTREAM_API_KEY.get()


@contextmanager
def enter_upstream_key(key: Optional[str]) -> Iterator[None]:
    """Bind ``key`` to the current task / contextvar context.

    Passing ``None`` is allowed and binds nothing — the contextvar stays
    at its default.  This makes the call site in the chat handler
    symmetric whether or not the request is in BYO-key mode.

    On exit, the previous value is restored via the standard
    ``ContextVar.reset`` token mechanism, so nested ``enter_upstream_key``
    calls behave like a stack.
    """
    if key is None:
        yield
        return
    token = _UPSTREAM_API_KEY.set(key)
    try:
        yield
    finally:
        _UPSTREAM_API_KEY.reset(token)


def normalize_new_api_base_url(base_url: str) -> str:
    """Return ``base_url`` stripped of trailing slash and trailing ``/v1``.

    ``NEW_API_BASE_URL`` is consumed in two places with different path
    expectations: the upstream validator hits ``GET /v1/models`` to
    accept-or-reject a user's key at login, and the AIAgent's OpenAI-
    compatible client expects ``base_url`` to already include the
    version path so it can append ``/chat/completions`` itself.  If we
    consumed the raw env-var in both, operators would have to pick one
    convention and the other surface would break: the symptom the
    operator hits here is "key validates fine but every chat turn
    returns an empty response after 3 retries" (the SDK hit
    ``{root}/chat/completions`` instead of ``{root}/v1/chat/completions``
    and the upstream returned 404 → empty body).

    The fix is to normalize to a canonical root, then add the right
    suffix at each call site:

    - validator       → ``{root}/v1/models``
    - chat (AIAgent)  → ``{root}/v1``

    Empty / whitespace-only input returns the empty string unchanged so
    "not configured" stays a single check at the call site.
    """
    s = (base_url or "").strip().rstrip("/")
    if s.endswith("/v1"):
        s = s[:-3].rstrip("/")
    return s


def derive_user_id(api_key: str) -> str:
    """Map an upstream API key to a deterministic ``u_<12hex>`` user_id.

    The hash uses sha256 and takes the first ``_USER_ID_HASH_LEN`` hex
    characters of the digest.  Properties:

    - **Deterministic**: the same key always derives the same user_id,
      so a user logging in from a second browser lands in the same
      workspace and sees the same conversation history.
    - **One-way**: knowing the user_id does not reveal the key, so
      enumerating ``web_workspaces/`` does not leak credentials.
    - **Format-compatible** with legacy ``u_<12hex>`` IDs minted by
      ``UserStore`` — workspaces and SessionDB rows interoperate.

    A 12-hex prefix gives 48 bits of entropy.  Collisions among real
    keys are vanishingly unlikely (birthday bound ≈ 2^24 keys for a
    1-in-million collision); we accept the small risk in exchange for
    the short, human-recognizable identifier.

    Raises :class:`ValueError` for an empty / whitespace-only key.
    """
    if not api_key or not api_key.strip():
        raise ValueError("api_key must be a non-empty string")
    digest = hashlib.sha256(api_key.encode("utf-8")).hexdigest()
    return _USER_ID_PREFIX + digest[:_USER_ID_HASH_LEN]
