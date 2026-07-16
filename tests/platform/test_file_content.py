"""File content download for previews (images / md / pdf)."""

from __future__ import annotations

from tests.platform.conftest import bind_upstream_key, register_user


def test_download_file_content_returns_bytes(client, mock_upstream_key):
    data, cookie = register_user(client)
    bind_upstream_key(client)
    ws_id = data["workspace"]["id"]
    body = b"# Hello preview\n"
    up = client.post(
        f"/api/v1/workspaces/{ws_id}/files?ingest=false",
        files={"files": ("notes.md", body, "text/markdown")},
        cookies={"hermes_session": cookie},
    )
    assert up.status_code == 200, up.text
    file_id = up.json()[0]["id"]

    resp = client.get(
        f"/api/v1/workspaces/{ws_id}/files/{file_id}/content",
        cookies={"hermes_session": cookie},
    )
    assert resp.status_code == 200
    assert resp.content == body
    ct = resp.headers.get("content-type", "")
    assert "markdown" in ct or "text" in ct or "octet-stream" in ct


def test_download_file_content_isolates_other_tenant(client, mock_upstream_key):
    data_a, cookie_a = register_user(client, email="owner@example.com")
    bind_upstream_key(client)
    ws_a = data_a["workspace"]["id"]
    up = client.post(
        f"/api/v1/workspaces/{ws_a}/files?ingest=false",
        files={"files": ("secret.md", b"private", "text/markdown")},
        cookies={"hermes_session": cookie_a},
    )
    assert up.status_code == 200
    file_id = up.json()[0]["id"]

    data_b, cookie_b = register_user(client, email="intruder@example.com")
    ws_b = data_b["workspace"]["id"]
    # Same file_id against B's workspace → 404
    resp_ws = client.get(
        f"/api/v1/workspaces/{ws_b}/files/{file_id}/content",
        cookies={"hermes_session": cookie_b},
    )
    assert resp_ws.status_code == 404
    # Correct workspace but wrong session → 401/403/404
    resp_auth = client.get(
        f"/api/v1/workspaces/{ws_a}/files/{file_id}/content",
        cookies={"hermes_session": cookie_b},
    )
    assert resp_auth.status_code in (401, 403, 404)
