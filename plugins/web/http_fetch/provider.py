"""HTTP-fetch web provider — zero-key extract via httpx + stdlib HTML parser.

Always-available extract backend for the multi-user web service.  When the
operator hasn't configured a paid extract API (Firecrawl/Tavily/Exa/Parallel),
``web.extract_backend: http-fetch`` keeps ``web_extract`` working end-to-end:
issue a GET, strip ``<script>``/``<style>``, walk the DOM with stdlib
``html.parser.HTMLParser`` to recover headings/paragraphs/lists as lightweight
markdown.  Quality is below the paid providers — no JS rendering, no
readability extraction, no charset auto-detection beyond ``Content-Type`` —
but it's good enough for the common "fetch this article / docs page / RSS
item" case and avoids the silent "search-only backend" failure mode users
hit when only ``ddgs`` is registered.

Does NOT advertise ``supports_search`` — search continues to flow through
``ddgs`` / ``brave-free`` / ``searxng`` / etc.

SSRF is gated upstream in :func:`tools.web_tools.web_extract_tool` via
``is_safe_url`` BEFORE the provider sees a URL, so this module assumes its
inputs are externally reachable; do not weaken that contract.
"""

from __future__ import annotations

import asyncio
import logging
import re
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urljoin

from agent.web_search_provider import WebSearchProvider

logger = logging.getLogger(__name__)


# Per-URL fetch budget.  Hard caps so a single huge page can't blow the
# event loop or the model's context window — the LLM summarizer downstream
# in :func:`tools.web_tools.web_extract_tool` will further compress.
_FETCH_TIMEOUT_S = 20.0
_MAX_BYTES = 4_000_000  # 4 MB cap on raw response body
_MAX_CHARS = 200_000    # cap on extracted text before LLM summarization

_BLOCK_TAGS = {
    "p", "div", "section", "article", "header", "footer", "nav", "main",
    "aside", "ul", "ol", "li", "blockquote", "pre", "table", "tr", "br", "hr",
    "h1", "h2", "h3", "h4", "h5", "h6",
}
_SKIP_TAGS = {"script", "style", "noscript", "template", "svg", "iframe"}
_HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}


class _HTMLToText(HTMLParser):
    """Lossy HTML→text walker.

    Not a true markdown converter — we keep just enough structure
    (headings + paragraph breaks + list bullets) for the LLM summarizer
    to do its job downstream.  Strips entire ``<script>``/``<style>``/etc.
    subtrees, including their text content.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: List[str] = []
        self._skip_depth = 0
        self._title_parts: List[str] = []
        self._in_title = False
        self._list_stack: List[str] = []  # "ul" | "ol"
        self._ol_counter: List[int] = []

    @property
    def title(self) -> str:
        return "".join(self._title_parts).strip()

    @property
    def text(self) -> str:
        # Collapse runs of >2 blank lines into exactly 2 — keeps the output
        # readable without bleeding all the structure the LLM might use.
        joined = "".join(self._parts)
        joined = re.sub(r"[ \t]+\n", "\n", joined)
        joined = re.sub(r"\n{3,}", "\n\n", joined)
        return joined.strip()

    def handle_starttag(self, tag: str, attrs):
        if self._skip_depth:
            if tag in _SKIP_TAGS:
                self._skip_depth += 1
            return
        if tag in _SKIP_TAGS:
            self._skip_depth = 1
            return
        if tag == "title":
            self._in_title = True
            return
        if tag in _HEADING_TAGS:
            level = int(tag[1])
            self._parts.append("\n\n" + ("#" * level) + " ")
            return
        if tag == "li":
            if self._list_stack and self._list_stack[-1] == "ol":
                self._ol_counter[-1] += 1
                self._parts.append(f"\n{self._ol_counter[-1]}. ")
            else:
                self._parts.append("\n- ")
            return
        if tag in {"ul", "ol"}:
            self._list_stack.append(tag)
            self._ol_counter.append(0)
            self._parts.append("\n")
            return
        if tag == "br":
            self._parts.append("\n")
            return
        if tag == "hr":
            self._parts.append("\n\n---\n\n")
            return
        if tag in _BLOCK_TAGS:
            self._parts.append("\n")
            return

    def handle_endtag(self, tag: str):
        if self._skip_depth:
            if tag in _SKIP_TAGS:
                self._skip_depth -= 1
            return
        if tag == "title":
            self._in_title = False
            return
        if tag in {"ul", "ol"}:
            if self._list_stack:
                self._list_stack.pop()
                self._ol_counter.pop()
            self._parts.append("\n")
            return
        if tag in _HEADING_TAGS:
            self._parts.append("\n")
            return
        if tag in _BLOCK_TAGS:
            self._parts.append("\n")
            return

    def handle_data(self, data: str):
        if self._skip_depth:
            return
        if self._in_title:
            self._title_parts.append(data)
            return
        if data:
            self._parts.append(data)


def _decode_body(raw: bytes, content_type: str) -> str:
    """Decode response bytes to text using the Content-Type charset hint.

    Falls back to UTF-8 with ``errors="replace"`` so a mis-declared page
    still gives the LLM something to work with rather than raising.
    """
    charset = "utf-8"
    if content_type:
        match = re.search(r"charset=([\w\-]+)", content_type, re.IGNORECASE)
        if match:
            charset = match.group(1).strip()
    try:
        return raw.decode(charset, errors="replace")
    except (LookupError, UnicodeDecodeError):
        return raw.decode("utf-8", errors="replace")


def _looks_like_html(content_type: str, body: str) -> bool:
    ct = (content_type or "").lower()
    if "html" in ct or "xml" in ct:
        return True
    if not ct:
        # Plain-text content-types or unspecified — peek at the body.
        head = body[:256].lstrip().lower()
        return head.startswith("<!doctype html") or head.startswith("<html") or "<body" in head
    return False


def _extract_text(body: str, content_type: str) -> Tuple[str, str]:
    """Return (title, text) for the given response body.

    For non-HTML payloads (plain text, JSON, markdown), passes the body
    through untouched and returns an empty title.
    """
    if _looks_like_html(content_type, body):
        parser = _HTMLToText()
        try:
            parser.feed(body)
            parser.close()
        except Exception as exc:  # noqa: BLE001 — HTMLParser is lenient but not bulletproof
            logger.debug("HTMLParser raised on body: %s", exc)
            return "", body[:_MAX_CHARS]
        text = parser.text or body[:_MAX_CHARS]
        if len(text) > _MAX_CHARS:
            text = text[:_MAX_CHARS] + "\n\n[... truncated ...]"
        return parser.title, text
    # Plain text / JSON / etc. — hand the body through, capped.
    if len(body) > _MAX_CHARS:
        return "", body[:_MAX_CHARS] + "\n\n[... truncated ...]"
    return "", body


async def _fetch_one(client, url: str) -> Dict[str, Any]:
    """Fetch and extract one URL.  Failures surface as ``error`` fields."""
    try:
        resp = await client.get(url, follow_redirects=True, timeout=_FETCH_TIMEOUT_S)
    except Exception as exc:  # noqa: BLE001 — httpx raises a tree of types
        msg = str(exc) or exc.__class__.__name__
        return {
            "url": url, "title": "", "content": "", "raw_content": "",
            "error": f"http fetch failed: {msg}",
            "metadata": {"sourceURL": url},
        }

    final_url = str(resp.url) if resp.url else url
    status = resp.status_code
    if status >= 400:
        return {
            "url": final_url, "title": "", "content": "", "raw_content": "",
            "error": f"HTTP {status}",
            "metadata": {"sourceURL": url, "status_code": status},
        }

    raw_bytes = bytes(resp.content[:_MAX_BYTES])
    content_type = resp.headers.get("content-type", "")
    body = _decode_body(raw_bytes, content_type)
    title, text = _extract_text(body, content_type)
    return {
        "url": final_url,
        "title": title,
        "content": text,
        "raw_content": text,
        "metadata": {
            "sourceURL": url,
            "status_code": status,
            "content_type": content_type,
        },
    }


class HTTPFetchWebProvider(WebSearchProvider):
    """Always-available extract-only provider.

    Pairs with a search provider (ddgs, brave-free, …) for the full
    "search then read" workflow that ``web_search`` + ``web_extract``
    expose to the agent.
    """

    @property
    def name(self) -> str:
        return "http-fetch"

    @property
    def display_name(self) -> str:
        return "HTTP fetch (no key)"

    def is_available(self) -> bool:
        # httpx is a core dependency — see pyproject.toml. The plugin is
        # therefore always usable; no env var / API key check needed.
        return True

    def supports_search(self) -> bool:
        return False

    def supports_extract(self) -> bool:
        return True

    async def extract(self, urls: List[str], **kwargs: Any) -> List[Dict[str, Any]]:
        """Fetch each URL concurrently and return per-URL result dicts."""
        if not urls:
            return []
        try:
            import httpx
        except ImportError:
            return [
                {
                    "url": u, "title": "", "content": "", "raw_content": "",
                    "error": "httpx not installed (core dependency missing)",
                    "metadata": {"sourceURL": u},
                }
                for u in urls
            ]

        # Mimic a real browser UA so sites that block default httpx UA
        # (e.g. Cloudflare's basic challenge tier) still return content.
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        }

        async with httpx.AsyncClient(
            headers=headers,
            timeout=_FETCH_TIMEOUT_S,
            limits=httpx.Limits(max_connections=10),
        ) as client:
            tasks = [_fetch_one(client, u) for u in urls]
            return await asyncio.gather(*tasks)

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": "HTTP fetch (no key)",
            "badge": "free · no key · extract only",
            "tag": "Plain HTTP GET + stdlib HTML→text. Fork-bundled default for web_chat deployments without a paid extract API.",
            "env_vars": [],
        }
