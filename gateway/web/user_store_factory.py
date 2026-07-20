"""Factory: legacy SQLite UserStore vs SQLAlchemy PlatformStore."""

from __future__ import annotations

import os
from typing import Union

from gateway.web.platform.database import get_database_url
from gateway.web.platform.store import PlatformStore, create_platform_store
from gateway.web.users import UserStore

StoreType = Union[UserStore, PlatformStore]


def create_user_store(db_path=None) -> StoreType:
    """Return the active user/session store for web_chat + platform-api.

    - ``PLATFORM_DATABASE_URL`` set → :class:`PlatformStore` (PostgreSQL/SQLite)
    - otherwise → legacy :class:`UserStore` (SQLite ``web_users.db``)
    """
    url = get_database_url()
    if url:
        return create_platform_store(url)
    return UserStore(db_path)
