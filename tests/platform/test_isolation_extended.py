"""Cross-user isolation: conversations, memory, knowledge, disabled accounts."""

from __future__ import annotations

import pytest

from platform_api.deps import get_store
from tests.platform.conftest import (
    bind_upstream_key,
    register_user,
    set_gateway_cookie,
)


def _seed_session(db, *, session_id: str, user_id: str, content: str = "secret") -> None:
    db.create_session(session_id, source="web_chat", user_id=user_id)
    db.append_message(session_id, role="user", content=content)


def _two_users(client, mock_upstream_key):
    """Register + bind two platform users; return (user_a, cookie_a, user_b, cookie_b)."""
    del mock_upstream_key  # fixture applies upstream validator stubs
    body_a, cookie_a = register_user(client, email="alice@example.com")
    bind_upstream_key(client)
    body_b, cookie_b = register_user(client, email="bob@example.com")
    bind_upstream_key(client)
    return (
        body_a["user"]["user_id"],
        cookie_a,
        body_b["user"]["user_id"],
        cookie_b,
    )


# ── 会话越权（Agent Gateway）────────────────────────────────────────────


@pytest.mark.asyncio
async def test_user_cannot_read_other_users_conversation(
    client, gateway, mock_upstream_key,
):
    """GET /api/conversations/{id} masks cross-tenant access as 404."""
    user_a, cookie_a, user_b, cookie_b = _two_users(client, mock_upstream_key)

    _seed_session(
        gateway.db,
        session_id="sess_alice_only",
        user_id=user_a,
        content="alice private",
    )

    set_gateway_cookie(gateway.client, cookie_b)
    resp = await gateway.client.get("/api/conversations/sess_alice_only")
    assert resp.status == 404

    set_gateway_cookie(gateway.client, cookie_a)
    ok = await gateway.client.get("/api/conversations/sess_alice_only")
    assert ok.status == 200
    data = await ok.json()
    assert data["messages"][0]["content"] == "alice private"
    assert user_a != user_b


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("http_method", "payload"),
    [
        ("patch", {"title": "hacked title"}),
        ("delete", None),
        ("post", {"pinned": True}),
    ],
)
async def test_user_cannot_mutate_other_users_conversation(
    client, gateway, mock_upstream_key, http_method, payload,
):
    """Rename / delete / pin 他人会话均返回 404，不泄露会话存在性。"""
    user_a, _cookie_a, _user_b, cookie_b = _two_users(client, mock_upstream_key)
    _seed_session(
        gateway.db,
        session_id="sess_alice_mut",
        user_id=user_a,
        content="do not touch",
    )

    set_gateway_cookie(gateway.client, cookie_b)
    url = "/api/conversations/sess_alice_mut"
    if http_method == "patch":
        resp = await gateway.client.patch(url, json=payload)
    elif http_method == "delete":
        resp = await gateway.client.delete(url)
    else:
        resp = await gateway.client.post(f"{url}/flags", json=payload)
    assert resp.status == 404

    # Owner can still read.
    set_gateway_cookie(gateway.client, _cookie_a)
    still = await gateway.client.get(url)
    assert still.status == 200


@pytest.mark.asyncio
async def test_conversation_list_hides_other_users_sessions(
    client, gateway, mock_upstream_key,
):
    """GET /api/conversations 仅返回当前用户的会话。"""
    user_a, cookie_a, _user_b, cookie_b = _two_users(client, mock_upstream_key)
    _seed_session(gateway.db, session_id="sess_a_list", user_id=user_a)

    set_gateway_cookie(gateway.client, cookie_b)
    resp_b = await gateway.client.get("/api/conversations")
    assert resp_b.status == 200
    ids_b = {c["id"] for c in (await resp_b.json())["conversations"]}
    assert "sess_a_list" not in ids_b

    set_gateway_cookie(gateway.client, cookie_a)
    resp_a = await gateway.client.get("/api/conversations")
    assert resp_a.status == 200
    ids_a = {c["id"] for c in (await resp_a.json())["conversations"]}
    assert "sess_a_list" in ids_a


# ── 记忆越权（Platform API）──────────────────────────────────────────────


def test_user_cannot_read_other_users_memory(client, mock_upstream_key):
    """GET memory 仅限 workspace 属主。"""
    reg_a, _ = register_user(client, email="mem-a@example.com")
    ws_a = reg_a["workspace"]["id"]
    bind_upstream_key(client)

    patch = client.patch(
        f"/api/v1/workspaces/{ws_a}/memory",
        json={"long_term": "alice memory only"},
    )
    assert patch.status_code == 200

    register_user(client, email="mem-b@example.com")
    bind_upstream_key(client)

    get_b = client.get(f"/api/v1/workspaces/{ws_a}/memory")
    assert get_b.status_code == 404


def test_user_cannot_patch_other_users_memory(client, mock_upstream_key):
    """PATCH memory 不能写入他人 workspace。"""
    reg_a, _ = register_user(client, email="mem-patch-a@example.com")
    ws_a = reg_a["workspace"]["id"]
    bind_upstream_key(client)

    register_user(client, email="mem-patch-b@example.com")
    bind_upstream_key(client)

    patch_b = client.patch(
        f"/api/v1/workspaces/{ws_a}/memory",
        json={"long_term": "malicious overwrite"},
    )
    assert patch_b.status_code == 404


# ── 知识库越权（Platform API）────────────────────────────────────────────


def test_user_cannot_search_other_users_knowledge(client, mock_upstream_key):
    """Knowledge search 仅限 workspace 属主。"""
    reg_a, _ = register_user(client, email="rag-a@example.com")
    ws_a = reg_a["workspace"]["id"]
    bind_upstream_key(client)

    up = client.post(
        f"/api/v1/workspaces/{ws_a}/files",
        files={"files": ("secret.txt", b"alice confidential delta", "text/plain")},
    )
    assert up.status_code == 200

    register_user(client, email="rag-b@example.com")
    bind_upstream_key(client)

    search = client.post(
        f"/api/v1/workspaces/{ws_a}/knowledge/search",
        json={"query": "confidential", "top_k": 3},
    )
    assert search.status_code == 404


def test_user_cannot_list_or_delete_other_users_files(client, mock_upstream_key):
    """文件列表 / 删除不能跨 workspace 访问。"""
    reg_a, _ = register_user(client, email="files-a@example.com")
    ws_a = reg_a["workspace"]["id"]
    bind_upstream_key(client)

    up = client.post(
        f"/api/v1/workspaces/{ws_a}/files",
        files={"files": ("owned.txt", b"alice file content", "text/plain")},
    )
    assert up.status_code == 200
    file_id = up.json()[0]["id"]

    register_user(client, email="files-b@example.com")
    bind_upstream_key(client)

    list_b = client.get(f"/api/v1/workspaces/{ws_a}/files")
    assert list_b.status_code == 404

    status_b = client.get(f"/api/v1/workspaces/{ws_a}/files/{file_id}/status")
    assert status_b.status_code == 404

    delete_b = client.delete(f"/api/v1/workspaces/{ws_a}/files/{file_id}")
    assert delete_b.status_code == 404


# ── 禁用账户 ─────────────────────────────────────────────────────────────


def test_disabled_user_cannot_login_or_use_session(client, mock_upstream_key):
    """Disabled users fail login and existing sessions stop working."""
    reg, cookie = register_user(client, email="disable-me@example.com")
    user_id = reg["user"]["user_id"]
    bind_upstream_key(client)

    store = get_store()
    store.set_disabled(user_id, True)

    login = client.post(
        "/api/v1/auth/login",
        json={"email": "disable-me@example.com", "password": "password123"},
    )
    assert login.status_code == 401

    me = client.get("/api/v1/auth/me", cookies={"hermes_session": cookie})
    assert me.status_code == 401


@pytest.mark.asyncio
async def test_disabled_user_cannot_chat(client, gateway, mock_upstream_key):
    reg, cookie = register_user(client, email="nochat@example.com")
    user_id = reg["user"]["user_id"]
    bind_upstream_key(client)

    get_store().set_disabled(user_id, True)

    set_gateway_cookie(gateway.client, cookie)
    chat = await gateway.client.post("/api/chat", json={"message": "hi"})
    assert chat.status == 401
