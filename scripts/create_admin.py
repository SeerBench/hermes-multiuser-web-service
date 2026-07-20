#!/usr/bin/env python3
"""Create a platform admin user (requires PLATFORM_DATABASE_URL)."""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone

from gateway.web.platform.database import session_scope
from gateway.web.platform.models import Tenant, User, Workspace
from gateway.web.platform.passwords import hash_password
from gateway.web.platform.store import create_platform_store
from gateway.web.sandbox import ensure_workspace


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a platform admin user")
    parser.add_argument("--email", required=True)
    parser.add_argument("--password", required=True, help="min 8 characters")
    parser.add_argument("--name", default=None, help="tenant display name")
    args = parser.parse_args()

    url = os.environ.get("PLATFORM_DATABASE_URL", "").strip()
    if not url:
        print("PLATFORM_DATABASE_URL is required", file=sys.stderr)
        return 1
    if len(args.password) < 8:
        print("password must be at least 8 characters", file=sys.stderr)
        return 1

    email = args.email.strip().lower()
    store = create_platform_store(url)
    now = datetime.now(timezone.utc)

    from sqlalchemy import select

    with session_scope(store._engine) as db:
        existing = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
        if existing:
            existing.role = "admin"
            existing.password_hash = hash_password(args.password)
            existing.status = "active"
            existing.disabled = False
            print(f"promoted existing user to admin: {existing.id}")
            return 0

        tenant = Tenant(name=args.name or email.split("@", 1)[0], plan="free")
        db.add(tenant)
        db.flush()

        user = User(
            tenant_id=tenant.id,
            email=email,
            password_hash=hash_password(args.password),
            role="admin",
            status="active",
            upstream_status="pending_bind",
            created_at=now,
            last_seen_at=now,
        )
        db.add(user)
        db.flush()

        ws = Workspace(tenant_id=tenant.id, owner_id=user.id, name="Default")
        db.add(ws)
        ensure_workspace(user.id)
        print(f"created admin user_id={user.id} workspace_id={ws.id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
