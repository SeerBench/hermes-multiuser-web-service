"""HTTP-fetch extract plugin — bundled, auto-loaded.

Fork-specific (hermes-multiuser-web-service) provider that gives
``web_extract`` a usable default when no paid extract backend
(Firecrawl/Tavily/Exa/Parallel) is configured.  Search is delegated to
the existing ``ddgs`` / ``brave-free`` / ``searxng`` providers — this
plugin only advertises ``supports_extract``.
"""

from __future__ import annotations

from plugins.web.http_fetch.provider import HTTPFetchWebProvider


def register(ctx) -> None:
    """Register the http-fetch provider with the plugin context."""
    ctx.register_web_search_provider(HTTPFetchWebProvider())
