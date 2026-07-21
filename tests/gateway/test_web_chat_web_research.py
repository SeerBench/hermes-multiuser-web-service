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

    def test_ddgs_available_returns_ok_status(self, monkeypatch):
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
        assert status.search_backend == "ddgs"
        assert status.extract_available is True
        assert status.extract_backend == "http-fetch"
        assert status.ok is True
        assert status.fix_hint is None

    def test_search_hidden_when_ddgs_missing_returns_fix_hint(self, monkeypatch):
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
        assert status.search_backend == "firecrawl"
        assert status.ok is False
        assert status.fix_hint is not None
        assert "web-chat" in status.fix_hint
        assert "search_backend: ddgs" in status.fix_hint

    def test_explicit_search_backend_ddgs_overrides_dead_shared_backend(
        self, monkeypatch
    ):
        """Shared backend firecrawl (no key) must not hide search when ddgs is set."""
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

        from gateway.web.web_research_status import probe_web_research_status

        status = probe_web_research_status()

        assert status.search_backend == "ddgs"
        assert status.search_available is True
        assert status.ok is True

    def test_log_web_research_status_emits_warning_when_unavailable(self, monkeypatch):
        monkeypatch.setattr(
            web_tools,
            "_load_web_config",
            lambda: {"backend": "", "search_backend": "", "extract_backend": ""},
        )
        monkeypatch.setattr(web_tools, "_ddgs_package_importable", lambda: False)
        monkeypatch.setattr(web_tools, "_is_backend_available", _fake_avail(set()))

        from gateway.web import web_research_status as wrs

        status = wrs.probe_web_research_status()

        with patch.object(wrs.logger, "warning") as mock_warn:
            wrs.log_web_research_status(status)
            mock_warn.assert_called_once()
            msg = mock_warn.call_args[0][0]
            assert "web_search" in msg

    def test_log_web_research_status_emits_info_when_ok(self, monkeypatch):
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
            # logger.info uses %-formatting; backend names are in positional args.
            assert mock_info.call_args[0][1] == "ddgs"
            assert mock_info.call_args[0][2] == "http-fetch"
