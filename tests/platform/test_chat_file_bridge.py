"""Chat upload bridge registers FileRecord without auto-ingest."""

from __future__ import annotations

import pytest
from aiohttp import FormData
from sqlalchemy import select

from gateway.web.platform.models import FileRecord
from platform_api.deps import get_store
from tests.platform.conftest import bind_upstream_key, register_user, set_gateway_cookie


def _upload_form(filename: str, content: bytes) -> FormData:
    data = FormData()
    data.add_field("file", content, filename=filename, content_type="text/plain")
    return data


@pytest.mark.asyncio
async def test_chat_upload_registers_file_record_skipped(gateway, client, mock_upstream_key, tmp_path):
    data, cookie = register_user(client)
    bind_upstream_key(client)
    ws_id = data["workspace"]["id"]
    user_id = data["user"]["user_id"]
    set_gateway_cookie(gateway.client, cookie)

    content = b"hello from chat upload"
    mp = await gateway.client.post(
        "/api/uploads",
        data=_upload_form("note.txt", content),
    )
    assert mp.status == 200, await mp.text()

    store = get_store()
    with store._session_factory() as db:
        rows = db.execute(
            select(FileRecord).where(FileRecord.workspace_id == ws_id)
        ).scalars().all()
    assert len(rows) == 1
    rec = rows[0]
    assert rec.origin == "chat"
    assert rec.status == "skipped"

    # Cross-user isolation: second user sees nothing
    data2, cookie2 = register_user(client, email="other@example.com")
    with store._session_factory() as db:
        rows2 = db.execute(
            select(FileRecord).where(FileRecord.workspace_id == data2["workspace"]["id"])
        ).scalars().all()
    assert rows2 == []


@pytest.mark.asyncio
async def test_platform_upload_ingest_false_skips(gateway, client, mock_upstream_key):
    data, cookie = register_user(client)
    bind_upstream_key(client)
    ws_id = data["workspace"]["id"]

    files = {"files": ("doc.txt", b"platform only", "text/plain")}
    resp = client.post(
        f"/api/v1/workspaces/{ws_id}/files?ingest=false",
        files=files,
        cookies={"hermes_session": cookie},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body[0]["status"] == "skipped"
    assert body[0]["origin"] == "platform"
