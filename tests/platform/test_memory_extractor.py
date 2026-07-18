"""Memory extractor feature-flag stub — never writes permanent memory."""

from platform_api.services.memory_extractor import (
    extractor_enabled,
    maybe_enqueue_memory_extraction,
)


def test_extractor_disabled_by_default(monkeypatch):
    monkeypatch.delenv("PLATFORM_MEMORY_EXTRACTOR", raising=False)
    assert extractor_enabled() is False
    result = maybe_enqueue_memory_extraction(
        user_id="u1",
        workspace_id="w1",
        session_id="s1",
        messages=[{"role": "user", "content": "remember I like cats"}],
    )
    assert result == {"enqueued": False, "reason": "disabled"}


def test_extractor_stub_when_enabled(monkeypatch):
    monkeypatch.setenv("PLATFORM_MEMORY_EXTRACTOR", "1")
    assert extractor_enabled() is True
    result = maybe_enqueue_memory_extraction(
        user_id="u1",
        workspace_id="w1",
        session_id="s1",
    )
    assert result["enqueued"] is False
    assert result["reason"] == "stub"
