"""Tests for the fork-bundled ``http-fetch`` zero-key web extract provider.

``plugins/web/http_fetch`` is added by the hermes-multiuser-web-service fork
so ``web_extract`` has a usable default in deployments that never configure a
paid Firecrawl/Tavily/Exa/Parallel key — the common case for a multi-user
self-host where every user shares one out-of-the-box tool surface.

Covers:
- HTTPFetchWebProvider interface — name, capability flags, availability,
  WebSearchProvider subclassing
- HTML→text extraction (_HTMLToText / _extract_text / _decode_body /
  _looks_like_html): headings, paragraphs, ordered + unordered lists,
  script/style stripping, non-HTML passthrough, charset handling, truncation
- async extract() — happy path, empty input, HTTP >= 400, network failure,
  redirect final URL, concurrent multi-URL, byte cap
- web_tools backend wiring — _is_backend_available / _get_backend /
  _get_extract_backend recognise "http-fetch"
- end-to-end through web_extract_tool with web.extract_backend: http-fetch

The provider registers itself as extract-only — search still flows through
ddgs/brave-free/searxng — so we also assert supports_search() is False.

No network is touched: ``httpx.AsyncClient`` is replaced with an in-memory
fake. The upstream ``tests/tools/conftest.py`` helper is intentionally NOT
used here — http-fetch is fork code, so this file registers it locally to
keep the shared conftest untouched (fork Strategy 2).
"""
from __future__ import annotations

import asyncio
import json

import pytest

from agent.web_search_provider import WebSearchProvider
from plugins.web.http_fetch.provider import (
    HTTPFetchWebProvider,
    _MAX_BYTES,
    _MAX_CHARS,
    _decode_body,
    _extract_text,
    _looks_like_html,
)


# ---------------------------------------------------------------------------
# In-memory httpx fake
# ---------------------------------------------------------------------------


class _FakeResp:
    """Minimal stand-in for ``httpx.Response`` used by ``_fetch_one``."""

    def __init__(self, *, url, status_code=200, content=b"", headers=None):
        self.url = url
        self.status_code = status_code
        self.content = content
        self.headers = headers or {}


def _install_fake_httpx(monkeypatch, *, responses=None, raises=None):
    """Replace ``httpx.AsyncClient`` with a fake driven by per-URL maps.

    ``responses``: dict mapping request URL -> ``_FakeResp``.
    ``raises``:    dict mapping request URL -> exception instance to raise.

    ``httpx.Limits`` (used by the provider) is left real — only the client is
    swapped — so the provider's construction call still works unmodified.
    """
    import httpx

    responses = responses or {}
    raises = raises or {}

    class _FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            # Accept and ignore headers/timeout/limits the provider passes.
            self.calls = []

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_a):
            return False

        async def get(self, url, **kwargs):
            self.calls.append((url, kwargs))
            if url in raises:
                raise raises[url]
            if url in responses:
                return responses[url]
            raise AssertionError(f"unexpected URL fetched in test: {url}")

    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# ---------------------------------------------------------------------------
# Provider interface
# ---------------------------------------------------------------------------


class TestHTTPFetchProviderInterface:
    def test_name(self):
        assert HTTPFetchWebProvider().name == "http-fetch"

    def test_display_name(self):
        assert HTTPFetchWebProvider().display_name == "HTTP fetch (no key)"

    def test_is_available_always_true(self):
        # httpx is a core dependency, so the provider is unconditionally usable.
        assert HTTPFetchWebProvider().is_available() is True

    def test_extract_only_capabilities(self):
        p = HTTPFetchWebProvider()
        assert p.supports_extract() is True
        assert p.supports_search() is False
        assert p.supports_crawl() is False

    def test_implements_web_search_provider(self):
        assert issubclass(HTTPFetchWebProvider, WebSearchProvider)

    def test_setup_schema_has_no_env_vars(self):
        schema = HTTPFetchWebProvider().get_setup_schema()
        assert schema["env_vars"] == []
        assert schema["name"]


# ---------------------------------------------------------------------------
# HTML -> text extraction
# ---------------------------------------------------------------------------


class TestHTMLExtraction:
    def test_title_and_headings_and_paragraph(self):
        html = (
            "<html><head><title>Doc Title</title></head>"
            "<body><h1>Heading One</h1><p>Hello <b>world</b>.</p></body></html>"
        )
        title, text = _extract_text(html, "text/html")
        assert title == "Doc Title"
        assert "# Heading One" in text
        assert "Hello world." in text

    def test_unordered_and_ordered_lists(self):
        html = (
            "<body><ul><li>alpha</li><li>beta</li></ul>"
            "<ol><li>first</li><li>second</li></ol></body>"
        )
        _title, text = _extract_text(html, "text/html")
        assert "- alpha" in text
        assert "- beta" in text
        assert "1. first" in text
        assert "2. second" in text

    def test_script_style_noscript_stripped(self):
        html = (
            "<body><p>keep</p>"
            "<script>var leak = 'SECRET';</script>"
            "<style>.x{color:red}</style>"
            "<noscript>nojs</noscript></body>"
        )
        _title, text = _extract_text(html, "text/html")
        assert "keep" in text
        assert "SECRET" not in text
        assert "color:red" not in text
        assert "nojs" not in text

    def test_nested_skip_subtree_recovers(self):
        # A <script> containing markup must not permanently disable output.
        html = "<body><script><span>x</span></script><p>after</p></body>"
        _title, text = _extract_text(html, "text/html")
        assert "after" in text
        assert "x" not in text.replace("after", "")

    def test_plain_text_passthrough_no_title(self):
        body = "just some plain text, no markup"
        title, text = _extract_text(body, "text/plain")
        assert title == ""
        assert text == body

    def test_json_passthrough(self):
        body = '{"key": "value", "n": 1}'
        title, text = _extract_text(body, "application/json")
        assert title == ""
        assert text == body

    def test_truncation_adds_marker(self):
        body = "x" * (_MAX_CHARS + 100)
        title, text = _extract_text(body, "text/plain")
        assert "[... truncated ...]" in text
        assert len(text) <= _MAX_CHARS + len("\n\n[... truncated ...]")

    def test_collapses_excess_blank_lines(self):
        html = "<body><p>a</p><p></p><p></p><p></p><p>b</p></body>"
        _title, text = _extract_text(html, "text/html")
        assert "\n\n\n" not in text


class TestDecodeBody:
    def test_uses_content_type_charset(self):
        raw = "café".encode("latin-1")
        assert _decode_body(raw, "text/html; charset=latin-1") == "café"

    def test_defaults_to_utf8(self):
        raw = "héllo".encode("utf-8")
        assert _decode_body(raw, "text/html") == "héllo"

    def test_unknown_charset_falls_back_to_utf8(self):
        raw = "data".encode("utf-8")
        # Bogus charset must not raise — fall back to utf-8 with replacement.
        assert _decode_body(raw, "text/html; charset=not-a-real-charset") == "data"


class TestLooksLikeHTML:
    def test_html_content_type(self):
        assert _looks_like_html("text/html", "") is True

    def test_xml_content_type(self):
        assert _looks_like_html("application/xml", "") is True

    def test_plain_text_content_type(self):
        assert _looks_like_html("text/plain", "<html>nope</html>") is False

    def test_sniffs_body_when_no_content_type(self):
        assert _looks_like_html("", "<!DOCTYPE html><html></html>") is True
        assert _looks_like_html("", "<html><body>hi</body></html>") is True
        assert _looks_like_html("", "plain words") is False


# ---------------------------------------------------------------------------
# async extract()
# ---------------------------------------------------------------------------


class TestExtract:
    def test_empty_urls_returns_empty(self):
        assert _run(HTTPFetchWebProvider().extract([])) == []

    def test_happy_path_single_url(self, monkeypatch):
        url = "https://example.com/article"
        html = (
            b"<html><head><title>Article</title></head>"
            b"<body><h1>Big News</h1><p>Body text here.</p></body></html>"
        )
        _install_fake_httpx(monkeypatch, responses={
            url: _FakeResp(url=url, content=html,
                           headers={"content-type": "text/html; charset=utf-8"}),
        })
        results = _run(HTTPFetchWebProvider().extract([url]))
        assert len(results) == 1
        r = results[0]
        assert r["url"] == url
        assert r["title"] == "Article"
        assert "# Big News" in r["content"]
        assert "Body text here." in r["content"]
        assert r["content"] == r["raw_content"]
        assert "error" not in r
        assert r["metadata"]["status_code"] == 200
        assert r["metadata"]["sourceURL"] == url

    def test_http_error_status_becomes_error_field(self, monkeypatch):
        url = "https://example.com/missing"
        _install_fake_httpx(monkeypatch, responses={
            url: _FakeResp(url=url, status_code=404, content=b"nope"),
        })
        results = _run(HTTPFetchWebProvider().extract([url]))
        assert results[0]["error"] == "HTTP 404"
        assert results[0]["content"] == ""
        assert results[0]["metadata"]["status_code"] == 404

    def test_network_failure_becomes_error_field(self, monkeypatch):
        url = "https://unreachable.example.com"
        _install_fake_httpx(monkeypatch, raises={
            url: RuntimeError("connection refused"),
        })
        results = _run(HTTPFetchWebProvider().extract([url]))
        assert results[0]["error"].startswith("http fetch failed:")
        assert "connection refused" in results[0]["error"]
        assert results[0]["content"] == ""

    def test_redirect_reports_final_url(self, monkeypatch):
        req = "https://example.com/old"
        final = "https://example.com/new"
        _install_fake_httpx(monkeypatch, responses={
            req: _FakeResp(url=final, content=b"<p>moved</p>",
                           headers={"content-type": "text/html"}),
        })
        results = _run(HTTPFetchWebProvider().extract([req]))
        assert results[0]["url"] == final
        # The original requested URL is preserved in metadata.
        assert results[0]["metadata"]["sourceURL"] == req

    def test_multiple_urls_preserve_order(self, monkeypatch):
        u1, u2, u3 = (
            "https://a.example.com",
            "https://b.example.com",
            "https://c.example.com",
        )
        _install_fake_httpx(monkeypatch, responses={
            u1: _FakeResp(url=u1, content=b"<p>one</p>", headers={"content-type": "text/html"}),
            u2: _FakeResp(url=u2, status_code=500, content=b"err"),
            u3: _FakeResp(url=u3, content=b"<p>three</p>", headers={"content-type": "text/html"}),
        })
        results = _run(HTTPFetchWebProvider().extract([u1, u2, u3]))
        assert [r["url"] for r in results] == [u1, u2, u3]
        assert "one" in results[0]["content"]
        assert results[1]["error"] == "HTTP 500"
        assert "three" in results[2]["content"]

    def test_body_byte_cap_enforced(self, monkeypatch):
        url = "https://huge.example.com"
        # 2x the cap of plain ascii; decoded content must not exceed limits.
        big = b"a" * (_MAX_BYTES * 2)
        _install_fake_httpx(monkeypatch, responses={
            url: _FakeResp(url=url, content=big, headers={"content-type": "text/plain"}),
        })
        results = _run(HTTPFetchWebProvider().extract([url]))
        # Raw body truncated to _MAX_BYTES before decode; text further capped
        # at _MAX_CHARS by _extract_text.
        assert len(results[0]["content"]) <= _MAX_CHARS + len("\n\n[... truncated ...]")


# ---------------------------------------------------------------------------
# web_tools backend wiring
# ---------------------------------------------------------------------------


class TestHTTPFetchBackendWiring:
    def test_is_backend_available_true(self):
        from tools import web_tools
        assert web_tools._is_backend_available("http-fetch") is True

    def test_configured_shared_backend_accepted(self, monkeypatch):
        from tools import web_tools
        monkeypatch.setattr(web_tools, "_load_web_config", lambda: {"backend": "http-fetch"})
        assert web_tools._get_backend() == "http-fetch"

    def test_extract_backend_override_selected(self, monkeypatch):
        from tools import web_tools
        monkeypatch.setattr(
            web_tools, "_load_web_config",
            lambda: {"backend": "ddgs", "extract_backend": "http-fetch"},
        )
        # ddgs is search-only; the per-capability override must win for extract.
        assert web_tools._get_extract_backend() == "http-fetch"


class TestZeroConfigExtractAutoRoute:
    """The fork auto-routes web_extract to http-fetch when the shared
    fallback would otherwise land on a search-only backend — so a zero-key
    deployment gets a working web_extract with no config at all.

    Requires the registry populated (the auto-route inspects the resolved
    backend's supports_extract via get_provider).
    """

    @pytest.fixture(autouse=True)
    def _registry(self):
        from agent.web_search_registry import register_provider, _reset_for_tests
        from plugins.web.ddgs.provider import DDGSWebSearchProvider
        _reset_for_tests()
        register_provider(DDGSWebSearchProvider())
        register_provider(HTTPFetchWebProvider())
        yield
        _reset_for_tests()

    def test_zero_config_routes_extract_to_http_fetch(self, monkeypatch):
        from tools import web_tools
        # No web config at all; ddgs is the search fallback.
        monkeypatch.setattr(web_tools, "_load_web_config", lambda: {})
        monkeypatch.setattr(web_tools, "_get_backend", lambda: "ddgs")
        assert web_tools._get_extract_backend() == "http-fetch"

    def test_shared_backend_ddgs_still_routes_extract_to_http_fetch(self, monkeypatch):
        from tools import web_tools
        # Operator set the shared web.backend: ddgs but no extract_backend.
        monkeypatch.setattr(web_tools, "_load_web_config", lambda: {"backend": "ddgs"})
        monkeypatch.setattr(web_tools, "_get_backend", lambda: "ddgs")
        assert web_tools._get_extract_backend() == "http-fetch"

    def test_explicit_search_only_extract_backend_is_respected(self, monkeypatch):
        from tools import web_tools
        # Explicit choice of a search-only backend is NOT overridden — the
        # user gets the precise "search-only" error downstream instead of a
        # silent switch.
        monkeypatch.setattr(
            web_tools, "_load_web_config", lambda: {"extract_backend": "ddgs"}
        )
        monkeypatch.setattr(web_tools, "_get_backend", lambda: "ddgs")
        assert web_tools._get_extract_backend() == "ddgs"

    def test_extract_capable_backend_not_overridden(self, monkeypatch):
        from tools import web_tools
        from agent.web_search_registry import register_provider
        from plugins.web.tavily.provider import TavilyWebSearchProvider
        register_provider(TavilyWebSearchProvider())
        # When the shared fallback resolves to an extract-capable backend,
        # the auto-route must NOT replace it with http-fetch.
        monkeypatch.setattr(web_tools, "_load_web_config", lambda: {})
        monkeypatch.setattr(web_tools, "_get_backend", lambda: "tavily")
        assert web_tools._get_extract_backend() == "tavily"

    def test_zero_config_web_extract_tool_end_to_end(self, monkeypatch):
        from tools import web_tools

        url = "https://example.com/post"
        html = (
            b"<html><head><title>Zero Config</title></head>"
            b"<body><h1>It Works</h1><p>No key needed.</p></body></html>"
        )
        _install_fake_httpx(monkeypatch, responses={
            url: _FakeResp(url=url, content=html,
                           headers={"content-type": "text/html"}),
        })
        # Truly zero config — no extract_backend, ddgs is the shared default.
        monkeypatch.setattr(web_tools, "_load_web_config", lambda: {})
        monkeypatch.setattr(web_tools, "_get_backend", lambda: "ddgs")
        monkeypatch.setattr(web_tools, "is_safe_url", lambda u: True)
        monkeypatch.setattr("tools.interrupt.is_interrupted", lambda: False, raising=False)

        result = json.loads(
            _run(web_tools.web_extract_tool([url], use_llm_processing=False))
        )
        assert "results" in result, result
        assert result["results"][0]["title"] == "Zero Config"
        assert "# It Works" in result["results"][0]["content"]


# ---------------------------------------------------------------------------
# End-to-end through web_extract_tool
# ---------------------------------------------------------------------------


class TestWebExtractToolEndToEnd:
    @pytest.fixture(autouse=True)
    def _register_http_fetch(self):
        from agent.web_search_registry import register_provider, _reset_for_tests
        _reset_for_tests()
        register_provider(HTTPFetchWebProvider())
        yield
        _reset_for_tests()

    def test_web_extract_via_http_fetch(self, monkeypatch):
        from tools import web_tools

        url = "https://docs.example.com/page"
        html = (
            b"<html><head><title>Docs</title></head>"
            b"<body><h1>Install</h1><p>Run the setup script.</p></body></html>"
        )
        _install_fake_httpx(monkeypatch, responses={
            url: _FakeResp(url=url, content=html,
                           headers={"content-type": "text/html; charset=utf-8"}),
        })
        monkeypatch.setattr(
            web_tools, "_load_web_config",
            lambda: {"extract_backend": "http-fetch"},
        )
        monkeypatch.setattr(web_tools, "is_safe_url", lambda u: True)
        monkeypatch.setattr("tools.interrupt.is_interrupted", lambda: False, raising=False)

        result_str = _run(
            web_tools.web_extract_tool([url], use_llm_processing=False)
        )
        result = json.loads(result_str)
        results = result["results"]
        assert len(results) == 1
        assert results[0]["title"] == "Docs"
        assert "# Install" in results[0]["content"]
        assert "Run the setup script." in results[0]["content"]

    def test_web_extract_blocks_ssrf_before_fetch(self, monkeypatch):
        from tools import web_tools

        # If is_safe_url rejects, the provider must never be reached — so no
        # fake httpx is installed; a fetch attempt would raise AssertionError.
        monkeypatch.setattr(
            web_tools, "_load_web_config",
            lambda: {"extract_backend": "http-fetch"},
        )
        monkeypatch.setattr(web_tools, "is_safe_url", lambda u: False)
        monkeypatch.setattr("tools.interrupt.is_interrupted", lambda: False, raising=False)

        result_str = _run(
            web_tools.web_extract_tool(["http://169.254.169.254/latest/meta-data"],
                                       use_llm_processing=False)
        )
        result = json.loads(result_str)
        assert len(result["results"]) == 1
        assert "private or internal" in result["results"][0]["error"].lower()
