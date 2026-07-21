"""Startup probe for web_search / web_extract backend availability.

Called once from :meth:`gateway.platforms.web_chat.WebChatAdapter.connect`
so operators see misconfiguration (missing ``ddgs``, stale ``web.backend``)
before users report that ``web_search`` vanished from the model's tool list.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger("hermes.web.web_research")

# Operator copy-paste fix when search/extract backends fail the registry gate.
_RECOMMENDED_WEB_CONFIG = """\
web:
  backend: ddgs
  search_backend: ddgs
  extract_backend: http-fetch"""

_FIX_PREFIX = (
    "Install the [web-chat] extra (ships ddgs): "
    "uv pip install -e \".[web-chat,platform]\"\n"
    "Then set in ~/.hermes/config.yaml:\n"
    f"{_RECOMMENDED_WEB_CONFIG}"
)


@dataclass(frozen=True)
class WebResearchStatus:
    """Resolved backends and registry-gate booleans at probe time."""

    search_backend: str
    search_available: bool
    extract_backend: str
    extract_available: bool
    fix_hint: Optional[str] = None

    @property
    def ok(self) -> bool:
        return self.search_available and self.extract_available


def probe_web_research_status() -> WebResearchStatus:
    """Resolve search/extract backends without triggering gate WARNING logs."""
    from tools.web_tools import (
        _get_extract_backend,
        _get_search_backend,
        _is_backend_available,
    )

    search_backend = _get_search_backend()
    extract_backend = _get_extract_backend()
    search_ok = bool(_is_backend_available(search_backend))
    extract_ok = bool(_is_backend_available(extract_backend))

    fix_hint: Optional[str] = None
    if not search_ok or not extract_ok:
        parts: list[str] = []
        if not search_ok:
            parts.append(
                f"web_search unavailable (resolved backend={search_backend!r})"
            )
        if not extract_ok:
            parts.append(
                f"web_extract unavailable (resolved backend={extract_backend!r})"
            )
        fix_hint = "\n".join(parts) + f"\n\n{_FIX_PREFIX}"

    return WebResearchStatus(
        search_backend=search_backend,
        search_available=search_ok,
        extract_backend=extract_backend,
        extract_available=extract_ok,
        fix_hint=fix_hint,
    )


def log_web_research_status(status: WebResearchStatus) -> None:
    """Emit one INFO or WARNING line at gateway startup."""
    if status.ok:
        logger.info(
            "web research ready: web_search=%s (available) web_extract=%s (available)",
            status.search_backend,
            status.extract_backend,
        )
        return

    logger.warning(
        "web research misconfigured: web_search=%s available=%s; "
        "web_extract=%s available=%s. %s",
        status.search_backend,
        status.search_available,
        status.extract_backend,
        status.extract_available,
        status.fix_hint or _FIX_PREFIX,
    )
