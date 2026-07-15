"""Unit tests for web SaaS Apple / macOS-only skill exclusion."""

from __future__ import annotations

from gateway.web.skill_filters import is_web_excluded_skill


def test_apple_category_excluded():
    assert is_web_excluded_skill(category="apple", name="imessage") is True


def test_macos_only_platforms_excluded():
    assert is_web_excluded_skill(
        category="productivity",
        frontmatter={"platforms": ["macos"]},
    ) is True


def test_cross_platform_not_excluded():
    assert is_web_excluded_skill(
        category="research",
        name="arxiv",
        frontmatter={"platforms": ["linux", "macos", "windows"]},
    ) is False


def test_known_apple_names_excluded_without_category():
    for name in (
        "apple-notes",
        "apple-reminders",
        "findmy",
        "imessage",
        "macos-computer-use",
    ):
        assert is_web_excluded_skill(name=name) is True
