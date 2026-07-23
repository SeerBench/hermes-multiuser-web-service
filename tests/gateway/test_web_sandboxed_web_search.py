"""Tests for sandboxed web_search (Brave + ddgs hybrid)."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from gateway.web.sandbox import enter_user_context
from gateway.web.web_search_limits import (
    format_search_status_message,
    get_brave_remaining,
    parse_search_meta_from_result,
)
from gateway.web.web_search_router import resolve_backend_for_user, search_for_user
from gateway.web.usage_tracker import track


@pytest.fixture
def platform_env(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    db_path = tmp_path / "platform.db"
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("PLATFORM_DATABASE_URL", f"sqlite:///{db_path}")
    monkeypatch.setenv("NEW_API_BASE_URL", "http://upstream.test")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    from platform_api.deps import get_store

    get_store.cache_clear()
    yield db_path
    get_store.cache_clear()


@pytest.fixture
def alice_ctx(hermes_home):
    with enter_user_context("u_alice") as ws:
        yield ws


@pytest.fixture
def hermes_home(tmp_path, monkeypatch):
    home = tmp_path / "hermes_home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home


def _fake_provider(name: str, results=None):
    class _Prov:
        def supports_search(self):
            return True

        def search(self, query, limit):
            return {
                "success": True,
                "data": {
                    "web": results
                    or [
                        {
                            "title": "Example",
                            "url": "https://example.com/a",
                            "description": "desc",
                            "position": 1,
                        }
                    ]
                },
            }

    prov = _Prov()
    prov.name = name
    return prov


class TestResolveBackend:
    def test_brave_when_key_and_quota(self, monkeypatch):
        monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "brave-key")
        monkeypatch.setenv("WEB_SEARCH_BRAVE_MAX_PER_USER", "5")
        monkeypatch.setattr(
            "gateway.web.web_search_router.get_brave_remaining", lambda uid: 3
        )
        monkeypatch.setattr(
            "gateway.web.web_search_router._ddgs_importable", lambda: True
        )
        backend, reason = resolve_backend_for_user("u1")
        assert backend == "brave-free"
        assert reason is None

    def test_ddgs_when_brave_quota_exhausted(self, monkeypatch):
        monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "brave-key")
        monkeypatch.setattr(
            "gateway.web.web_search_router.get_brave_remaining", lambda uid: 0
        )
        monkeypatch.setattr(
            "gateway.web.web_search_router._ddgs_importable", lambda: True
        )
        backend, reason = resolve_backend_for_user("u1")
        assert backend == "ddgs"
        assert reason == "brave_quota_exhausted"

    def test_ddgs_when_no_brave_key(self, monkeypatch):
        monkeypatch.delenv("BRAVE_SEARCH_API_KEY", raising=False)
        monkeypatch.setattr(
            "gateway.web.web_search_router._ddgs_importable", lambda: True
        )
        backend, reason = resolve_backend_for_user("u1")
        assert backend == "ddgs"
        assert reason == "no_brave_key"

    def test_no_backend_when_both_unavailable(self, monkeypatch):
        monkeypatch.delenv("BRAVE_SEARCH_API_KEY", raising=False)
        monkeypatch.setattr(
            "gateway.web.web_search_router._ddgs_importable", lambda: False
        )
        backend, reason = resolve_backend_for_user("u1")
        assert backend is None
        assert reason == "no_backend"


class TestSearchForUser:
    def test_brave_success_enriches_meta_and_records(self, platform_env, monkeypatch):
        monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "brave-key")
        monkeypatch.setenv("WEB_SEARCH_BRAVE_MAX_PER_USER", "5")
        monkeypatch.setattr(
            "gateway.web.web_search_router.get_brave_remaining", lambda uid: 2
        )
        monkeypatch.setattr(
            "gateway.web.web_search_router._get_provider",
            lambda name: _fake_provider(name),
        )

        with patch("gateway.web.web_search_router.record_brave_use") as record:
            result = search_for_user("u_brave", "hello world", 3)

        assert result["success"] is True
        assert result["_meta"]["backend"] == "brave-free"
        assert result["_meta"]["brave_remaining"] == 1
        assert result["_meta"]["urls"] == ["https://example.com/a"]
        record.assert_called_once()

    def test_ddgs_fallback_when_quota_exhausted(self, monkeypatch):
        monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "brave-key")
        monkeypatch.setattr(
            "gateway.web.web_search_router.get_brave_remaining", lambda uid: 0
        )
        monkeypatch.setattr(
            "gateway.web.web_search_router._ddgs_importable", lambda: True
        )
        monkeypatch.setattr(
            "gateway.web.web_search_router._get_provider",
            lambda name: _fake_provider(name),
        )

        result = search_for_user("u_ddgs", "query", 5)
        assert result["success"] is True
        assert result["_meta"]["backend"] == "ddgs"
        assert result["_meta"]["fallback_reason"] == "brave_quota_exhausted"

    def test_cross_user_brave_quota_isolated(self, platform_env, monkeypatch):
        monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "brave-key")
        monkeypatch.setenv("WEB_SEARCH_BRAVE_MAX_PER_USER", "1")
        monkeypatch.setenv("WEB_SEARCH_BRAVE_WINDOW_SECONDS", "86400")
        monkeypatch.setattr(
            "gateway.web.web_search_router._get_provider",
            lambda name: _fake_provider(name),
        )
        monkeypatch.setattr(
            "gateway.web.web_search_router._ddgs_importable", lambda: True
        )

        from fastapi.testclient import TestClient
        from platform_api.main import app
        from tests.platform.conftest import register_user

        client = TestClient(app)
        user_a, _ = register_user(client, email="quota-a@example.com")
        user_b, _ = register_user(client, email="quota-b@example.com")
        uid_a = user_a["user"]["user_id"]
        uid_b = user_b["user"]["user_id"]

        r1 = search_for_user(uid_a, "q1", 3)
        assert r1["_meta"]["backend"] == "brave-free"

        r2 = search_for_user(uid_a, "q2", 3)
        assert r2["_meta"]["backend"] == "ddgs"
        assert r2["_meta"]["fallback_reason"] == "brave_quota_exhausted"

        r3 = search_for_user(uid_b, "q3", 3)
        assert r3["_meta"]["backend"] == "brave-free"

    def test_no_backend_returns_error(self, monkeypatch):
        monkeypatch.delenv("BRAVE_SEARCH_API_KEY", raising=False)
        monkeypatch.setattr(
            "gateway.web.web_search_router._ddgs_importable", lambda: False
        )
        result = search_for_user("u_none", "q", 3)
        assert result["success"] is False
        assert "error" in result


class TestSandboxedHandler:
    def test_handler_uses_user_context(self, alice_ctx, monkeypatch):
        monkeypatch.setattr(
            "gateway.web.tools.sandboxed_web_search.search_for_user_json",
            lambda uid, q, limit: json.dumps({"success": True, "user": uid}),
        )
        from gateway.web.tools.sandboxed_web_search import web_search_sandboxed

        out = json.loads(web_search_sandboxed("test query", 5))
        assert out["user"] == "u_alice"

    def test_handler_without_context_fails(self):
        from gateway.web.tools.sandboxed_web_search import web_search_sandboxed

        out = json.loads(web_search_sandboxed("q", 5))
        assert out["success"] is False


class TestStatusMessages:
    def test_brave_status_message(self):
        msg = format_search_status_message(
            {"backend": "brave-free", "brave_remaining": 7}
        )
        assert "Brave" in msg
        assert "7" in msg

    def test_ddgs_fallback_message(self):
        msg = format_search_status_message(
            {"backend": "ddgs", "fallback_reason": "brave_quota_exhausted"}
        )
        assert "DuckDuckGo" in msg
        assert "Brave" in msg

    def test_parse_meta_from_json_string(self):
        raw = json.dumps({"success": True, "_meta": {"backend": "ddgs", "urls": []}})
        meta = parse_search_meta_from_result(raw)
        assert meta["backend"] == "ddgs"


class TestBraveRemainingIntegration:
    def test_get_brave_remaining_after_track(self, platform_env, monkeypatch):
        monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "key")
        monkeypatch.setenv("WEB_SEARCH_BRAVE_MAX_PER_USER", "2")
        monkeypatch.setenv("WEB_SEARCH_BRAVE_WINDOW_SECONDS", "86400")

        from tests.platform.conftest import register_user
        from fastapi.testclient import TestClient
        from platform_api.main import app

        client = TestClient(app)
        body, _ = register_user(client, email="brave@example.com")
        user_id = body["user"]["user_id"]

        track(
            user_id,
            "tool",
            tool_name="web_search",
            metadata={"backend": "brave-free", "query": "a"},
        )
        assert get_brave_remaining(user_id) == 1
