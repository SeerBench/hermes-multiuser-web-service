"""Fork (hermes-multiuser-web-service) regression tests for per-capability
web-tool registry gating.

Brand-new file — upstream has no equivalent, so it never conflicts on rebase.

Background
----------
``web_search`` / ``web_extract`` are only handed to the model when their
registry ``check_fn`` passes (``tools/registry.py::get_definitions``).  The
fork swaps the shared ``check_web_api_key`` for two per-capability functions
(``check_web_search_available`` / ``check_web_extract_available``) so each tool
is gated on the backend its dispatch path would actually resolve
(``_get_search_backend`` / ``_get_extract_backend``), honoring
``web.search_backend`` / ``web.extract_backend`` instead of only the shared
``web.backend``.

The bug these lock in: a deployment with ``web.backend: firecrawl`` (no key)
but ``search_backend: ddgs`` / ``extract_backend: http-fetch`` had a working
dispatch path yet got BOTH tools hidden from the model, because the old shared
gate saw only the unavailable firecrawl.  These are invariant tests (exposure
follows the resolved capability backend), not snapshot/change-detector tests.
"""

import logging

from tools import web_tools
from tools.registry import invalidate_check_fn_cache, registry


def _fake_avail(available):
    """Return an ``_is_backend_available`` stub: only names in ``available`` are up."""
    available = set(available)
    return lambda backend: backend in available


class TestPerCapabilityToolGating:
    def test_web_search_exposed_when_search_backend_up_despite_dead_shared_backend(
        self, monkeypatch
    ):
        # The reported multi-user trap: shared web.backend is an unavailable
        # paid provider, but search is routed to a zero-key one.
        monkeypatch.setattr(
            web_tools,
            "_load_web_config",
            lambda: {"backend": "firecrawl", "search_backend": "ddgs"},
        )
        monkeypatch.setattr(web_tools, "_is_backend_available", _fake_avail({"ddgs"}))
        assert web_tools.check_web_search_available() is True

    def test_web_search_hidden_and_warns_when_no_search_backend(
        self, monkeypatch, caplog
    ):
        monkeypatch.setattr(
            web_tools, "_load_web_config", lambda: {"backend": "firecrawl"}
        )
        monkeypatch.setattr(web_tools, "_is_backend_available", _fake_avail(set()))
        with caplog.at_level(logging.WARNING, logger="tools.web_tools"):
            assert web_tools.check_web_search_available() is False
        # The diagnostic the operator greps for when a tool goes missing.
        assert "HIDDEN from the model" in caplog.text

    def test_web_extract_exposed_via_http_fetch_despite_dead_shared_backend(
        self, monkeypatch
    ):
        monkeypatch.setattr(
            web_tools,
            "_load_web_config",
            lambda: {"backend": "firecrawl", "extract_backend": "http-fetch"},
        )
        monkeypatch.setattr(
            web_tools, "_is_backend_available", _fake_avail({"http-fetch"})
        )
        assert web_tools.check_web_extract_available() is True

    def test_check_web_api_key_left_untouched(self, monkeypatch):
        """The shared upstream gate must keep its original (web.backend-only)
        semantics — the fix is additive, not a rewrite of check_web_api_key."""
        monkeypatch.setattr(
            web_tools,
            "_load_web_config",
            lambda: {"backend": "firecrawl", "search_backend": "ddgs"},
        )
        # firecrawl unavailable; ddgs available — but the SHARED gate only
        # looks at web.backend=firecrawl, so it still reports False.
        monkeypatch.setattr(web_tools, "_is_backend_available", _fake_avail({"ddgs"}))
        assert web_tools.check_web_api_key() is False

    def test_both_tools_reach_get_definitions_with_per_capability_backends(
        self, monkeypatch
    ):
        """End-to-end: the registry actually exposes both tools to the model."""
        monkeypatch.setattr(
            web_tools,
            "_load_web_config",
            lambda: {
                "backend": "firecrawl",
                "search_backend": "ddgs",
                "extract_backend": "http-fetch",
            },
        )
        monkeypatch.setattr(
            web_tools, "_is_backend_available", _fake_avail({"ddgs", "http-fetch"})
        )
        # check_fn results are TTL-cached by callable identity; clear so the
        # monkeypatched config is observed and we don't poison sibling tests.
        invalidate_check_fn_cache()
        try:
            defs = registry.get_definitions({"web_search", "web_extract"})
            names = {d["function"]["name"] for d in defs}
        finally:
            invalidate_check_fn_cache()
        assert "web_search" in names
        assert "web_extract" in names
