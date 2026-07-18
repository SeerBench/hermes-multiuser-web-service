"""Admin API: users pagination/filter, audit log listing, role gate."""

from __future__ import annotations

from sqlalchemy import select

from gateway.web.platform.database import session_scope
from gateway.web.platform.models import User
from platform_api.deps import get_store
from tests.platform.conftest import register_user


def _promote_admin(user_id: str) -> None:
    store = get_store()
    with session_scope(store._engine) as db:
        user = db.execute(select(User).where(User.id == user_id)).scalar_one()
        user.role = "admin"


def test_non_admin_cannot_list_users(client):
    register_user(client, email="pleb@example.com")
    resp = client.get("/api/v1/admin/users")
    assert resp.status_code == 403


def test_admin_lists_users_with_email_filter_and_pagination(client):
    body, _ = register_user(client, email="admin@example.com")
    _promote_admin(body["user"]["user_id"])
    register_user(client, email="alice@corp.example")
    register_user(client, email="bob@corp.example")
    # Re-login as admin (last register overwrote cookie).
    client.post("/api/v1/auth/logout")
    assert (
        client.post(
            "/api/v1/auth/login",
            json={"email": "admin@example.com", "password": "password123"},
        ).status_code
        == 200
    )

    page = client.get("/api/v1/admin/users", params={"limit": 2, "offset": 0})
    assert page.status_code == 200, page.text
    data = page.json()
    assert "users" in data and "total" in data
    assert data["total"] >= 3
    assert len(data["users"]) == 2
    assert data["limit"] == 2
    assert data["offset"] == 0

    filtered = client.get(
        "/api/v1/admin/users",
        params={"email": "alice@corp"},
    )
    assert filtered.status_code == 200
    emails = [u["email"] for u in filtered.json()["users"]]
    assert emails == ["alice@corp.example"]
    assert filtered.json()["total"] == 1


def test_admin_audit_log_lists_recent_actions(client):
    body, _ = register_user(client, email="auditor@example.com")
    admin_id = body["user"]["user_id"]
    _promote_admin(admin_id)
    # Trigger a recorded admin action.
    assert client.get("/api/v1/admin/stats").status_code == 200

    resp = client.get("/api/v1/admin/audit", params={"limit": 20, "offset": 0})
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["total"] >= 1
    actions = {row["action"] for row in payload["items"]}
    assert "admin.stats" in actions
    row = next(r for r in payload["items"] if r["action"] == "admin.stats")
    assert row["actor_id"] == admin_id
    assert "created_at" in row


def test_non_admin_cannot_read_audit(client):
    register_user(client, email="noaudit@example.com")
    assert client.get("/api/v1/admin/audit").status_code == 403
