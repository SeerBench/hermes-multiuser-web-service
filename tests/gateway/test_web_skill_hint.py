"""Skill hint must point at web_skill_* tools, not upstream skill_manage."""


def test_skill_hint_mentions_web_skill_view(monkeypatch):
    from gateway.platforms import web_chat as mod

    class FakeStore:
        def list_enabled_skill_names(self, user_id: str):
            assert user_id == "u1"
            return ["demo-skill"]

    monkeypatch.setattr(
        "gateway.web.platform.store.PlatformStore",
        FakeStore,
        raising=False,
    )
    # Adapter method uses isinstance(self.user_store, PlatformStore)
    adapter = object.__new__(mod.WebChatAdapter)
    adapter._user_store = FakeStore()

    import gateway.web.platform.store as store_mod

    monkeypatch.setattr(store_mod, "PlatformStore", FakeStore)

    hint = mod.WebChatAdapter._build_skill_hint(adapter, "u1")
    assert hint is not None
    assert "demo-skill" in hint
    assert "web_skill_view" in hint
    assert "skill_manage" not in hint
