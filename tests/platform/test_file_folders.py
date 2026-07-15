"""File folders, kind filter (images vs documents), and tag assignment."""

from __future__ import annotations

from tests.platform.conftest import bind_upstream_key, register_user


def _upload(
    client,
    ws_id: str,
    cookie: str,
    name: str = "a.txt",
    content: bytes = b"alpha content",
    mime: str = "text/plain",
    *,
    ingest: bool = False,
    folder_id: str | None = None,
):
    qs = f"ingest={str(ingest).lower()}"
    if folder_id:
        qs += f"&folder_id={folder_id}"
    return client.post(
        f"/api/v1/workspaces/{ws_id}/files?{qs}",
        files={"files": (name, content, mime)},
        cookies={"hermes_session": cookie},
    )


def test_list_files_includes_created_at(client, mock_upstream_key):
    data, cookie = register_user(client)
    bind_upstream_key(client)
    ws_id = data["workspace"]["id"]

    up = _upload(client, ws_id, cookie)
    assert up.status_code == 200
    assert isinstance(up.json()[0]["created_at"], (int, float))

    listing = client.get(
        f"/api/v1/workspaces/{ws_id}/files",
        cookies={"hermes_session": cookie},
    )
    assert listing.status_code == 200
    assert isinstance(listing.json()[0]["created_at"], (int, float))


def test_folder_create_rename_and_move_file(client, mock_upstream_key):
    data, cookie = register_user(client)
    bind_upstream_key(client)
    ws_id = data["workspace"]["id"]

    folder = client.post(
        f"/api/v1/workspaces/{ws_id}/file-folders",
        json={"name": "Reports"},
        cookies={"hermes_session": cookie},
    )
    assert folder.status_code == 200, folder.text
    folder_id = folder.json()["id"]
    assert folder.json()["name"] == "Reports"
    assert folder.json()["parent_id"] is None

    renamed = client.patch(
        f"/api/v1/workspaces/{ws_id}/file-folders/{folder_id}",
        json={"name": "Q1 Reports"},
        cookies={"hermes_session": cookie},
    )
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Q1 Reports"

    up = _upload(client, ws_id, cookie, name="notes.txt")
    file_id = up.json()[0]["id"]
    assert up.json()[0].get("folder_id") in (None, "")

    moved = client.patch(
        f"/api/v1/workspaces/{ws_id}/files/{file_id}",
        json={"folder_id": folder_id},
        cookies={"hermes_session": cookie},
    )
    assert moved.status_code == 200
    assert moved.json()["folder_id"] == folder_id

    in_folder = client.get(
        f"/api/v1/workspaces/{ws_id}/files?folder_id={folder_id}",
        cookies={"hermes_session": cookie},
    )
    assert in_folder.status_code == 200
    assert [f["id"] for f in in_folder.json()] == [file_id]

    root = client.get(
        f"/api/v1/workspaces/{ws_id}/files?folder_id=",
        cookies={"hermes_session": cookie},
    )
    # Explicit root: only files with null folder_id
    assert all(not f.get("folder_id") for f in root.json())


def test_list_files_kind_images_vs_documents(client, mock_upstream_key):
    data, cookie = register_user(client)
    bind_upstream_key(client)
    ws_id = data["workspace"]["id"]

    doc = _upload(client, ws_id, cookie, name="readme.md", content=b"# hi")
    assert doc.status_code == 200
    assert doc.json()[0]["status"] == "skipped"

    img = _upload(
        client,
        ws_id,
        cookie,
        name="photo.png",
        content=b"\x89PNG\r\n\x1a\n" + b"\x00" * 16,
        mime="image/png",
        ingest=True,
    )
    assert img.status_code == 200
    # Images never auto-ingest for RAG.
    assert img.json()[0]["status"] == "skipped"

    docs = client.get(
        f"/api/v1/workspaces/{ws_id}/files?kind=document",
        cookies={"hermes_session": cookie},
    )
    assert {f["filename"] for f in docs.json()} == {"readme.md"}

    images = client.get(
        f"/api/v1/workspaces/{ws_id}/files?kind=image",
        cookies={"hermes_session": cookie},
    )
    assert {f["filename"] for f in images.json()} == {"photo.png"}


def test_assign_tags_to_file(client, mock_upstream_key):
    data, cookie = register_user(client)
    bind_upstream_key(client)
    ws_id = data["workspace"]["id"]

    tag = client.post(
        f"/api/v1/workspaces/{ws_id}/file-tags",
        json={"name": "important"},
        cookies={"hermes_session": cookie},
    )
    tag_id = tag.json()["id"]
    up = _upload(client, ws_id, cookie)
    file_id = up.json()[0]["id"]

    patched = client.patch(
        f"/api/v1/workspaces/{ws_id}/files/{file_id}",
        json={"tag_ids": [tag_id]},
        cookies={"hermes_session": cookie},
    )
    assert patched.status_code == 200
    assert patched.json()["tag_ids"] == [tag_id]

    filtered = client.get(
        f"/api/v1/workspaces/{ws_id}/files?tag=important",
        cookies={"hermes_session": cookie},
    )
    assert [f["id"] for f in filtered.json()] == [file_id]


def test_delete_folder_reports_counts_then_force_clears(client, mock_upstream_key):
    """Non-empty folder → 409 with counts; force=true removes files + folder."""
    data, cookie = register_user(client)
    bind_upstream_key(client)
    ws_id = data["workspace"]["id"]

    folder = client.post(
        f"/api/v1/workspaces/{ws_id}/file-folders",
        json={"name": "Docs"},
        cookies={"hermes_session": cookie},
    )
    folder_id = folder.json()["id"]
    child = client.post(
        f"/api/v1/workspaces/{ws_id}/file-folders",
        json={"name": "Nested", "parent_id": folder_id},
        cookies={"hermes_session": cookie},
    )
    assert child.status_code == 200
    up = _upload(client, ws_id, cookie, name="a.txt", folder_id=folder_id)
    assert up.status_code == 200

    blocked = client.delete(
        f"/api/v1/workspaces/{ws_id}/file-folders/{folder_id}",
        cookies={"hermes_session": cookie},
    )
    assert blocked.status_code == 409, blocked.text
    detail = blocked.json()["detail"]
    assert detail["code"] == "folder_not_empty"
    assert detail["file_count"] == 1
    assert detail["folder_count"] == 1

    forced = client.delete(
        f"/api/v1/workspaces/{ws_id}/file-folders/{folder_id}?force=true",
        cookies={"hermes_session": cookie},
    )
    assert forced.status_code == 200, forced.text
    listing = client.get(
        f"/api/v1/workspaces/{ws_id}/file-folders",
        cookies={"hermes_session": cookie},
    )
    assert listing.json() == []
    files = client.get(
        f"/api/v1/workspaces/{ws_id}/files",
        cookies={"hermes_session": cookie},
    )
    assert files.json() == []


def test_folder_isolation_across_workspaces(client, mock_upstream_key):

    a, cookie_a = register_user(client, email="folder-a@example.com")
    b, cookie_b = register_user(client, email="folder-b@example.com")
    bind_upstream_key(client)
    ws_a = a["workspace"]["id"]
    ws_b = b["workspace"]["id"]

    folder = client.post(
        f"/api/v1/workspaces/{ws_a}/file-folders",
        json={"name": "Private"},
        cookies={"hermes_session": cookie_a},
    )
    folder_id = folder.json()["id"]

    denied = client.get(
        f"/api/v1/workspaces/{ws_b}/file-folders",
        cookies={"hermes_session": cookie_b},
    )
    assert denied.status_code == 200
    assert all(f["id"] != folder_id for f in denied.json())

    steal = client.patch(
        f"/api/v1/workspaces/{ws_b}/file-folders/{folder_id}",
        json={"name": "Stolen"},
        cookies={"hermes_session": cookie_b},
    )
    assert steal.status_code == 404
