"""API-key (legacy) upsert must create a Default workspace.

Without a workspace, the SPA still enters platformMode after refresh
(``platform.me`` succeeds) but Files / Memory / Skills show「未登录或无工作区」.
"""

from __future__ import annotations

from sqlalchemy import delete

from gateway.web.platform.database import session_scope
from gateway.web.platform.models import Workspace
from gateway.web.platform.store import PlatformStore, create_platform_store


def test_upsert_user_creates_default_workspace(platform_env):
    store = create_platform_store(f"sqlite:///{platform_env}")
    assert isinstance(store, PlatformStore)

    store.upsert_user("u_apikey_legacy01")
    ws = store.get_default_workspace("u_apikey_legacy01")
    assert ws is not None
    assert ws["name"] == "Default"
    assert ws["id"]


def test_upsert_user_backfills_workspace_for_existing_user(platform_env):
    """Users created before this fix get a workspace on next upsert."""
    store = create_platform_store(f"sqlite:///{platform_env}")
    store.upsert_user("u_backfill_user01")
    assert store.get_default_workspace("u_backfill_user01") is not None

    with session_scope(store._engine) as db:
        db.execute(delete(Workspace).where(Workspace.owner_id == "u_backfill_user01"))

    assert store.get_default_workspace("u_backfill_user01") is None

    store.upsert_user("u_backfill_user01")
    restored = store.get_default_workspace("u_backfill_user01")
    assert restored is not None
    assert restored["name"] == "Default"


def test_ensure_default_workspace_creates_when_missing(platform_env):
    store = create_platform_store(f"sqlite:///{platform_env}")
    store.upsert_user("u_ensure_ws_01")
    with session_scope(store._engine) as db:
        db.execute(delete(Workspace).where(Workspace.owner_id == "u_ensure_ws_01"))

    ws = store.ensure_default_workspace("u_ensure_ws_01")
    assert ws is not None
    assert ws["name"] == "Default"
