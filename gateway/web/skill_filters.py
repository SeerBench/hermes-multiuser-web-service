"""Web SaaS skill visibility filters (fork-only).

Apple / macOS-only skills require local macOS apps (Notes, iMessage, Find My,
Accessibility). They are useless in the multi-user browser surface and must
not appear in the Skills UI or be suggested to the web_chat agent — even when
the gateway host itself runs on macOS.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

# Category directory used by upstream bundled Apple skills.
_WEB_EXCLUDED_CATEGORIES = frozenset({"apple"})

# Belt-and-suspenders name list for the five known macOS-only Apple skills.
_WEB_EXCLUDED_NAMES = frozenset({
    "apple-notes",
    "apple-reminders",
    "findmy",
    "imessage",
    "macos-computer-use",
})


def is_macos_only_platforms(platforms: Any) -> bool:
    """True when frontmatter ``platforms`` is exclusively ``macos``."""
    if not platforms:
        return False
    if isinstance(platforms, str):
        platforms = [platforms]
    if not isinstance(platforms, (list, tuple)):
        return False
    normalized = {str(p).lower().strip() for p in platforms if str(p).strip()}
    return normalized == {"macos"}


def is_web_excluded_skill(
    *,
    category: Optional[str] = None,
    name: Optional[str] = None,
    frontmatter: Optional[Mapping[str, Any]] = None,
    platforms: Any = None,
) -> bool:
    """Return True when a skill must stay hidden from web-chat / Skills UI."""
    if category and str(category).strip().lower() in _WEB_EXCLUDED_CATEGORIES:
        return True
    if name and str(name).strip().lower() in _WEB_EXCLUDED_NAMES:
        return True
    fm = frontmatter or {}
    plats = platforms if platforms is not None else fm.get("platforms")
    return is_macos_only_platforms(plats)
