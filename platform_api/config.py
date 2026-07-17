"""Application settings."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    database_url: str
    new_api_base_url: str
    cookie_ttl_seconds: int
    cookie_secure: bool
    session_cookie: str = "hermes_session"
    # Login brute-force guard (in-process; see platform_api.services.rate_limit).
    login_max_failures: int = 5
    login_window_seconds: float = 300.0

    @classmethod
    def from_env(cls) -> "Settings":
        db = os.environ.get("PLATFORM_DATABASE_URL", "").strip()
        if not db:
            raise RuntimeError("PLATFORM_DATABASE_URL is required for platform-api")
        return cls(
            database_url=db,
            new_api_base_url=os.environ.get("NEW_API_BASE_URL", "").strip(),
            cookie_ttl_seconds=int(os.environ.get("PLATFORM_COOKIE_TTL_SECONDS", "604800")),
            cookie_secure=os.environ.get("PLATFORM_COOKIE_SECURE", "false").lower()
            in ("1", "true", "yes"),
            login_max_failures=int(os.environ.get("PLATFORM_LOGIN_MAX_FAILURES", "5")),
            login_window_seconds=float(
                os.environ.get("PLATFORM_LOGIN_WINDOW_SECONDS", "300")
            ),
        )
