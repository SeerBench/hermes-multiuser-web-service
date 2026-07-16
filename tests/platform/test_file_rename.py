"""PATCH file filename (rename) for workspace file list."""

from __future__ import annotations

from tests.platform.conftest import bind_upstream_key, register_user


def test_rename_file_updates_filename(client, mock_upstream_key):
    data, cookie = register_user(client)
    bind_upstream_key(client)
    ws_id = data["workspace"]["id"]
    up = client.post(
        f"/api/v1/workspaces/{ws_id}/files?ingest=false",
        files={"files": ("old.md", b"# hi", "text/markdown")},
        cookies={"hermes_session": cookie},
    )
    assert up.status_code == 200
    file_id = up.json()[0]["id"]

    renamed = client.patch(
        f"/api/v1/workspaces/{ws_id}/files/{file_id}",
        json={"filename": "new-name.md"},
        cookies={"hermes_session": cookie},
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["filename"] == "new-name.md"

    listed = client.get(
        f"/api/v1/workspaces/{ws_id}/files",
        cookies={"hermes_session": cookie},
    )
    assert listed.status_code == 200
    assert listed.json()[0]["filename"] == "new-name.md"


def test_rename_file_rejects_other_tenant(client, mock_upstream_key):
    data_a, cookie_a = register_user(client, email="a@example.com")
    bind_upstream_key(client)
    ws_a = data_a["workspace"]["id"]
    up = client.post(
        f"/api/v1/workspaces/{ws_a}/files?ingest=false",
        files={"files": ("secret.md", b"x", "text/markdown")},
        cookies={"hermes_session": cookie_a},
    )
    file_id = up.json()[0]["id"]

    _data_b, cookie_b = register_user(client, email="b@example.com")
    resp = client.patch(
        f"/api/v1/workspaces/{ws_a}/files/{file_id}",
        json={"filename": "stolen.md"},
        cookies={"hermes_session": cookie_b},
    )
    assert resp.status_code in (401, 403, 404)
