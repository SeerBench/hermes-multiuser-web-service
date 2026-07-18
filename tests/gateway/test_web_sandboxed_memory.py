"""Toolset wiring for web_memory (no Platform DB required)."""


def test_hermes_web_chat_toolset_uses_web_memory_not_memory():
    from toolsets import TOOLSETS

    tools = TOOLSETS["hermes-web-chat"]["tools"]
    assert "web_memory" in tools
    assert "memory" not in tools
