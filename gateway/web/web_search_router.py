"""Hybrid Brave + ddgs routing for multi-user web_search."""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, Optional, Tuple

from gateway.web.web_search_limits import (
    brave_search_api_key_configured,
    get_brave_max_per_user,
    get_brave_remaining,
    record_brave_use,
)

logger = logging.getLogger("hermes.web.web_search_router")

_BACKEND_BRAVE = "brave-free"
_BACKEND_DDGS = "ddgs"


def _ddgs_importable() -> bool:
    try:
        import ddgs  # noqa: F401

        return True
    except ImportError:
        return False


def resolve_backend_for_user(user_id: str) -> Tuple[Optional[str], Optional[str]]:
    """Return ``(backend_name, fallback_reason)`` for this user."""
    ddgs_ok = _ddgs_importable()
    brave_ok = brave_search_api_key_configured() and get_brave_max_per_user() > 0

    if brave_ok and get_brave_remaining(user_id) > 0:
        return _BACKEND_BRAVE, None

    if ddgs_ok:
        if brave_ok:
            return _BACKEND_DDGS, "brave_quota_exhausted"
        return _BACKEND_DDGS, "no_brave_key"

    if brave_ok:
        # Brave key present but user quota exhausted and ddgs missing.
        return None, "brave_quota_exhausted_no_ddgs"

    return None, "no_backend"


def _get_provider(name: str):
    from agent.web_search_registry import get_provider

    return get_provider(name)


def _extract_urls(data: Dict[str, Any]) -> list[str]:
    web = (data.get("data") or {}).get("web") or []
    urls: list[str] = []
    if not isinstance(web, list):
        return urls
    for item in web:
        if isinstance(item, dict):
            url = str(item.get("url") or "").strip()
            if url:
                urls.append(url)
    return urls


def _enrich_result(
    result: Dict[str, Any],
    *,
    backend: str,
    user_id: str,
    fallback_reason: Optional[str],
) -> Dict[str, Any]:
    urls = _extract_urls(result)
    limit = get_brave_max_per_user()
    remaining: Optional[int] = None
    if backend == _BACKEND_BRAVE:
        if result.get("success"):
            remaining = max(0, get_brave_remaining(user_id) - 1)
        else:
            remaining = get_brave_remaining(user_id)
    elif fallback_reason == "brave_quota_exhausted":
        remaining = 0

    result["_meta"] = {
        "backend": backend,
        "brave_remaining": remaining,
        "brave_limit": limit if brave_search_api_key_configured() else None,
        "fallback_reason": fallback_reason,
        "urls": urls,
        "url_count": len(urls),
    }
    return result


def search_for_user(user_id: str, query: str, limit: int = 5) -> Dict[str, Any]:
    """Run web_search for ``user_id`` with Brave-first, ddgs-fallback routing."""
    backend, fallback_reason = resolve_backend_for_user(user_id)
    if not backend:
        msg = "No web search backend available"
        if fallback_reason == "brave_quota_exhausted_no_ddgs":
            msg = (
                "Brave search quota exhausted and ddgs is not installed — "
                "install [web-chat] extra or wait for quota reset"
            )
        elif fallback_reason == "no_backend":
            msg = (
                "Configure BRAVE_SEARCH_API_KEY or install ddgs "
                "(uv pip install -e \".[web-chat]\")"
            )
        return {
            "success": False,
            "error": msg,
            "_meta": {
                "backend": None,
                "fallback_reason": fallback_reason,
                "urls": [],
                "url_count": 0,
            },
        }

    provider = _get_provider(backend)
    if provider is None or not provider.supports_search():
        return {
            "success": False,
            "error": f"Search provider {backend!r} is not registered",
            "_meta": {
                "backend": backend,
                "fallback_reason": fallback_reason,
                "urls": [],
                "url_count": 0,
            },
        }

    safe_limit = max(1, min(int(limit or 5), 20))
    try:
        result = provider.search(query, safe_limit)
    except Exception as exc:
        logger.warning("web_search provider %s failed: %s", backend, exc)
        result = {"success": False, "error": str(exc)}

    if not isinstance(result, dict):
        result = {"success": False, "error": "invalid provider response"}

    enriched = _enrich_result(
        result,
        backend=backend,
        user_id=user_id,
        fallback_reason=fallback_reason,
    )

    if enriched.get("success") and backend == _BACKEND_BRAVE:
        record_brave_use(user_id, query=query, urls=_extract_urls(enriched))

    return enriched


def search_for_user_json(user_id: str, query: str, limit: int = 5) -> str:
    """JSON string wrapper for registry handler."""
    return json.dumps(
        search_for_user(user_id, query, limit),
        indent=2,
        ensure_ascii=False,
    )
