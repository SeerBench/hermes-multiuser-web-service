"""Shared FastAPI dependencies."""

from __future__ import annotations

from functools import lru_cache
from typing import Optional

from fastapi import Cookie, HTTPException

from gateway.web.key_storage import KeyVault
from gateway.web.platform.store import PlatformStore
from gateway.web.user_store_factory import create_user_store
from platform_api.config import Settings


@lru_cache
def get_settings() -> Settings:
    return Settings.from_env()


@lru_cache
def get_store() -> PlatformStore:
    store = create_user_store()
    if not isinstance(store, PlatformStore):
        raise RuntimeError("platform-api requires PLATFORM_DATABASE_URL")
    return store


@lru_cache
def get_vault() -> KeyVault:
    return KeyVault()


def get_current_user_id(
    hermes_session: Optional[str] = Cookie(default=None, alias="hermes_session"),
) -> str:
    if not hermes_session:
        raise HTTPException(status_code=401, detail="unauthorized")
    try:
        data = get_store().verify_web_session(hermes_session)
    except Exception:
        raise HTTPException(status_code=401, detail="unauthorized") from None
    return data["user_id"]


def require_admin(
    hermes_session: Optional[str] = Cookie(default=None, alias="hermes_session"),
) -> str:
    uid = get_current_user_id(hermes_session)
    user = get_store().get_user(uid)
    if not user or user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="admin required")
    return uid
