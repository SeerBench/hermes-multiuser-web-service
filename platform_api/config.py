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
    # Public SPA origin for password-reset links (no trailing slash).
    public_base_url: str = "http://127.0.0.1:8643"
    reset_token_ttl_seconds: int = 3600
    # SMTP (optional — ConsoleMailer when host empty).
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    mail_from: str = ""
    smtp_use_tls: bool = True

    @classmethod
    def from_env(cls) -> "Settings":
        db = os.environ.get("PLATFORM_DATABASE_URL", "").strip()
        if not db:
            raise RuntimeError("PLATFORM_DATABASE_URL is required for platform-api")
        public = os.environ.get("PLATFORM_PUBLIC_BASE_URL", "http://127.0.0.1:8643").strip()
        public = public.rstrip("/")
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
            public_base_url=public or "http://127.0.0.1:8643",
            reset_token_ttl_seconds=int(
                os.environ.get("PLATFORM_RESET_TOKEN_TTL_SECONDS", "3600")
            ),
            smtp_host=os.environ.get("PLATFORM_SMTP_HOST", "").strip(),
            smtp_port=int(os.environ.get("PLATFORM_SMTP_PORT", "587")),
            smtp_user=os.environ.get("PLATFORM_SMTP_USER", "").strip(),
            smtp_password=os.environ.get("PLATFORM_SMTP_PASSWORD", "").strip(),
            mail_from=os.environ.get("PLATFORM_MAIL_FROM", "").strip(),
            smtp_use_tls=os.environ.get("PLATFORM_SMTP_USE_TLS", "true").lower()
            in ("1", "true", "yes"),
        )
