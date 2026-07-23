"""Tests for gateway web-research startup probe (ddgs default path).

Exercises :mod:`gateway.web.web_research_status` without live network calls.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

import tools.web_tools as web_tools


def _fake_avail(available: set[str]):
    def _is_backend_available(backend: str) -> bool:
        return backend in available

    return _is_backend_available


class TestProbeWebResearchStatus:
    """Happy path and operator-facing failure reasons."""

    def test_hybrid_available_returns_ok_status(self, monkeypatch):
        monkeypatch.setattr(
            "gateway.web.tools.sandboxed_web_search.check_sandboxed_web_search_available",
            lambda: True,
        )
        monkeypatch.setattr(
            web_tools,
            "_load_web_config",
            lambda: {
                "backend": "ddgs",
                "search_backend": "ddgs",
                "extract_backend": "http-fetch",
            },
        )
        monkeypatch.setattr(
            web_tools, "_is_backend_available", _fake_avail({"ddgs", "http-fetch"})
        )

        from gateway.web.web_research_status import probe_web_research_status

        status = probe_web_research_status()

        assert status.search_available is True
        assert status.search_backend == "brave-free+ddgs"
        assert status.extract_available is True
        assert status.ok is True

    def test_search_hidden_when_no_backend_returns_fix_hint(self, monkeypatch):
        monkeypatch.setattr(
            "gateway.web.tools.sandboxed_web_search.check_sandboxed_web_search_available",
            lambda: False,
        )
        monkeypatch.setattr(
            web_tools,
            "_load_web_config",
            lambda: {"backend": "firecrawl", "search_backend": "", "extract_backend": ""},
        )
        monkeypatch.setattr(web_tools, "_ddgs_package_importable", lambda: False)
        monkeypatch.setattr(web_tools, "_is_backend_available", _fake_avail(set()))

        from gateway.web.web_research_status import probe_web_research_status

        status = probe_web_research_status()

        assert status.search_available is False
        assert status.ok is False
        assert status.fix_hint is not None
        assert "BRAVE_SEARCH_API_KEY" in status.fix_hint

    def test_log_web_research_status_emits_info_when_ok(self, monkeypatch):
        monkeypatch.setattr(
            "gateway.web.tools.sandboxed_web_search.check_sandboxed_web_search_available",
            lambda: True,
        )
        monkeypatch.setattr(
            web_tools,
            "_load_web_config",
            lambda: {
                "backend": "ddgs",
                "search_backend": "ddgs",
                "extract_backend": "http-fetch",
            },
        )
        monkeypatch.setattr(
            web_tools, "_is_backend_available", _fake_avail({"ddgs", "http-fetch"})
        )

        from gateway.web import web_research_status as wrs

        status = wrs.probe_web_research_status()

        with patch.object(wrs.logger, "info") as mock_info:
            wrs.log_web_research_status(status)
            mock_info.assert_called_once()
            assert mock_info.call_args[0][1] == "brave-free+ddgs"
