"""Route hermes' auxiliary LLM chain through the BYO-key upstream.

Upstream ``agent.auxiliary_client`` runs side tasks (title generation,
conversation compression, vision analyze, etc.) through a hard-coded
provider fallback chain: OpenRouter → Nous Portal → custom endpoint →
generic API-key provider.  On a pure BYO-key web_chat deployment none
of those have credentials configured, so every chat turn produces a
flurry of identical warnings before the chain quietly fails over to
the main agent runtime:

    WARNING agent.auxiliary_client: Auxiliary: marking openrouter unhealthy …
    WARNING agent.auxiliary_client: Auxiliary Nous client unavailable …
    WARNING agent.auxiliary_client: Auxiliary: marking nous unhealthy …

Functionally harmless — auxiliary failure does not block chat — but
noisy enough to obscure real errors in the operator's logs.

This module installs three monkey-patches on ``agent.auxiliary_client``:

1. :func:`_resolve_custom_runtime` — in BYO mode, return the new-api
   gateway + the per-request user key (or a placeholder out-of-
   request), so the upstream's "custom endpoint" probe always
   succeeds and auxiliary side tasks billable to the user account.

2. :func:`_get_provider_chain` — in BYO mode, drop OpenRouter and
   Nous from the fallback chain entirely.

3. :func:`_try_openrouter` and :func:`_try_nous` — in BYO mode,
   silently return ``(None, None)`` without marking the provider
   unhealthy or emitting any warning.  This catches callers that
   probe these backends *directly* (most importantly
   ``_VISION_AUTO_PROVIDER_ORDER``, a hard-coded
   ``("openrouter", "nous")`` tuple that vision capability detection
   walks every chat turn — it calls ``_try_openrouter`` /
   ``_try_nous`` straight, completely bypassing patch 2's chain).
   Patches 2 and 3 are belt-and-suspenders: patch 2 covers the
   ``_resolve_auto`` fallback chain, patch 3 covers everything that
   skips the chain (vision, explicit-provider config, plugin code).
   Operators who genuinely want OR/Nous can leave
   ``NEW_API_BASE_URL`` unset and run a non-BYO deployment.

Why a monkey-patch (vs. patching the upstream function in-place):
``agent.auxiliary_client`` is upstream Hermes territory.  Per the
fork's Strategy-2 rule, we avoid edits to upstream files when we can
get the same outcome from a wrapper.  This file is on the fork-only
path (``gateway/web/``) and the patches are simple attribute swaps
that follow the same shape :mod:`gateway.web.sandbox` uses for the
HERMES_HOME override.

The fallback chain is preserved: if NEW_API_BASE_URL is not set, both
patches transparently defer to the upstream originals.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Optional, Tuple

logger = logging.getLogger("hermes.web.aux_byo_router")

_install_lock = threading.Lock()
_installed = False


_BYO_SKIP_CHAIN_LABELS = frozenset({"openrouter", "nous"})


def install_aux_byo_router() -> None:
    """Install BYO-aware monkey-patches on ``agent.auxiliary_client``.

    Patches ``_resolve_custom_runtime`` and ``_get_provider_chain``.
    Idempotent — safe to call from every :meth:`WebChatAdapter.connect`
    invocation; only the first call rebinds the attributes.
    """
    global _installed
    with _install_lock:
        if _installed:
            return
        try:
            from agent import auxiliary_client as _aux
        except Exception:  # pragma: no cover — auxiliary module missing
            logger.warning(
                "aux_byo_router: agent.auxiliary_client not importable — "
                "BYO auxiliary routing not installed"
            )
            return

        # ── Patch 1: _resolve_custom_runtime ────────────────────────────
        original_resolver = _aux._resolve_custom_runtime

        def _byo_aware_resolve_custom_runtime() -> (
            Tuple[Optional[str], Optional[str], Optional[str]]
        ):
            """Return (base_url, api_key, api_mode) for the auxiliary client.

            In BYO mode, hand back the new-api gateway + the per-request
            user key.  Otherwise defer to the original resolver.
            """
            new_api_url = os.getenv("NEW_API_BASE_URL", "").strip()
            if not new_api_url:
                return original_resolver()

            # Lazy imports — these live in the fork and we want to avoid
            # a hard import cycle at module-load time.
            from gateway.web.upstream_key import (
                get_upstream_key,
                normalize_new_api_base_url,
            )

            base = normalize_new_api_base_url(new_api_url) + "/v1"
            # In-request: get_upstream_key() returns the user's plaintext
            # key (ContextVar bound by enter_upstream_key, propagated to
            # the worker thread by chat_runner's ctx.run wrapper).
            # Out-of-request: returns None.  Either way auxiliary clients
            # see a usable base_url with an Authorization header that the
            # upstream will accept (in-request) or reject loudly
            # (out-of-request) — better than the alternative, which is
            # falling through to OpenRouter/Nous probes that spam
            # warnings on a deployment that intentionally configures
            # neither.
            key = get_upstream_key() or "no-key-required"
            return base, key, "chat_completions"

        _aux._resolve_custom_runtime = _byo_aware_resolve_custom_runtime

        # ── Patch 2: _get_provider_chain ────────────────────────────────
        # Belt-and-suspenders: even when patch 1 lets _resolve_auto's
        # Step-1 succeed, some auxiliary callers walk the chain
        # directly (or skip Step-1 because the main runtime hasn't been
        # registered yet via set_runtime_main).  In BYO mode, neither
        # OpenRouter nor Nous Portal can possibly be the right answer —
        # if the operator wanted them, they wouldn't have set
        # NEW_API_BASE_URL.  Dropping them from the chain at the source
        # eliminates the warning spam regardless of which code path
        # triggered the fallback.
        original_chain = _aux._get_provider_chain

        def _byo_aware_get_provider_chain():
            chain = original_chain()
            if not os.getenv("NEW_API_BASE_URL", "").strip():
                return chain
            return [(label, fn) for (label, fn) in chain
                    if label not in _BYO_SKIP_CHAIN_LABELS]

        _aux._get_provider_chain = _byo_aware_get_provider_chain

        # ── Patch 3: _try_openrouter / _try_nous ────────────────────────
        # ``_VISION_AUTO_PROVIDER_ORDER`` is a module-level tuple
        # hard-coded as ``("openrouter", "nous")`` that vision
        # capability detection walks on every chat turn — and it
        # invokes ``_try_openrouter`` / ``_try_nous`` *directly*
        # without ever touching ``_get_provider_chain``.  Without this
        # patch, every chat turn produces the
        #   "marking openrouter unhealthy for 60s"
        #   "Nous client unavailable (run: hermes auth)"
        # warning pair regardless of how cleanly the main chain
        # behaves.  In BYO mode neither is a meaningful backend, so
        # short-circuit them to silent (None, None) — same shape an
        # unconfigured backend would return *without* the mark-
        # unhealthy side effect.
        original_try_openrouter = _aux._try_openrouter
        original_try_nous = _aux._try_nous

        def _byo_silent_try_openrouter(*args, **kwargs):
            if os.getenv("NEW_API_BASE_URL", "").strip():
                return None, None
            return original_try_openrouter(*args, **kwargs)

        def _byo_silent_try_nous(*args, **kwargs):
            if os.getenv("NEW_API_BASE_URL", "").strip():
                return None, None
            return original_try_nous(*args, **kwargs)

        _aux._try_openrouter = _byo_silent_try_openrouter
        _aux._try_nous = _byo_silent_try_nous

        _installed = True
        # WARNING level so it shows in default startup logs and we can
        # see the install actually happened.  Drop to INFO once the
        # silent-warnings investigation is settled.
        logger.warning(
            "aux_byo_router: installed BYO-aware patches "
            "(_resolve_custom_runtime, _get_provider_chain); "
            "NEW_API_BASE_URL=%s; "
            "chain after patch = %s",
            os.getenv("NEW_API_BASE_URL", "").strip() or "<unset>",
            [label for (label, _) in _aux._get_provider_chain()],
        )
