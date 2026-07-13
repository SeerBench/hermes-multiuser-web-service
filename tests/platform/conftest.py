"""Shared fixtures for platform-api tests."""

from __future__ import annotations

import os
from pathlib import Path

import pytest


@pytest.fixture()
def platform_env(tmp_path, monkeypatch):
    """Hermetic PLATFORM_DATABASE_URL + HERMES_HOME for platform tests."""
    home = tmp_path / ".hermes"
    home.mkdir()
    db_path = tmp_path / "platform.db"
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("PLATFORM_DATABASE_URL", f"sqlite:///{db_path}")
    monkeypatch.setenv("UPSTREAM_PROVISIONER", "manual")
    monkeypatch.setenv("NEW_API_BASE_URL", "http://upstream.test")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    # Clear FastAPI dependency caches between tests.
    from platform_api import deps

    deps.get_settings.cache_clear()
    deps.get_store.cache_clear()
    deps.get_vault.cache_clear()
    yield db_path
    deps.get_settings.cache_clear()
    deps.get_store.cache_clear()
    deps.get_vault.cache_clear()


@pytest.fixture()
def client(platform_env):
    from fastapi.testclient import TestClient
    from platform_api.main import app

    return TestClient(app)
