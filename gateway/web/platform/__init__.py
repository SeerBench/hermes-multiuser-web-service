"""Platform control-plane persistence (PostgreSQL or SQLite via SQLAlchemy).

Shared by ``platform-api`` (FastAPI) and ``web_chat`` (Agent Gateway session
lookup).  When ``PLATFORM_DATABASE_URL`` is unset, the gateway falls back
to the legacy SQLite :class:`gateway.web.users.UserStore`.
"""

from gateway.web.platform.store import PlatformStore, create_platform_store

__all__ = ["PlatformStore", "create_platform_store"]
