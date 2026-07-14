"""File categories, tags, sort + manual ingest."""

from __future__ import annotations

from tests.platform.conftest import bind_upstream_key, register_user


def _upload(client, ws_id: str, cookie: str, name: str = "a.txt", ingest: bool = False):
    return client.post(
        f"/api/v1/workspaces/{ws_id}/files?ingest={str(ingest).lower()}",
        files={"files": (name, b"alpha content", "text/plain")},
        cookies={"hermes_session": cookie},
    )


def test_file_categories_and_tags(client, mock_upstream_key):
    data, cookie = register_user(client)
    bind_upstream_key(client)
    ws_id = data["workspace"]["id"]

    cat = client.post(
        f"/api/v1/workspaces/{ws_id}/file-categories",
        json={"name": "Reports"},
        cookies={"hermes_session": cookie},
    )
    assert cat.status_code == 200
    cat_id = cat.json()["id"]

    tag = client.post(
        f"/api/v1/workspaces/{ws_id}/file-tags",
        json={"name": "urgent"},
        cookies={"hermes_session": cookie},
    )
    assert tag.status_code == 200
    tag_id = tag.json()["id"]

    up = _upload(client, ws_id, cookie)
    assert up.status_code == 200
    file_id = up.json()[0]["id"]

    patched = client.patch(
        f"/api/v1/workspaces/{ws_id}/files/{file_id}",
        json={"category_id": cat_id, "tag_ids": [tag_id]},
        cookies={"hermes_session": cookie},
    )
    assert patched.status_code == 200
    body = patched.json()
    assert body["category_id"] == cat_id
    assert tag_id in body["tag_ids"]


def test_list_files_sort_by_name(client, mock_upstream_key):
    data, cookie = register_user(client)
    bind_upstream_key(client)
    ws_id = data["workspace"]["id"]

    _upload(client, ws_id, cookie, name="zulu.txt")
    _upload(client, ws_id, cookie, name="alpha.txt")

    resp = client.get(
        f"/api/v1/workspaces/{ws_id}/files?sort=name&order=asc",
        cookies={"hermes_session": cookie},
    )
    assert resp.status_code == 200
    names = [f["filename"] for f in resp.json()]
    assert names == sorted(names)


def test_manual_ingest_from_skipped(client, mock_upstream_key, monkeypatch):
    data, cookie = register_user(client)
    bind_upstream_key(client)
    ws_id = data["workspace"]["id"]

    up = _upload(client, ws_id, cookie, ingest=False)
    file_id = up.json()[0]["id"]
    assert up.json()[0]["status"] == "skipped"

    # Avoid heavy embedding in unit test — stub ingest to flip status.
    def _fake_ingest(file_id: str, user_id: str) -> None:
        from gateway.web.platform.database import session_scope
        from gateway.web.platform.models import FileRecord
        from platform_api.deps import get_store

        store = get_store()
        with session_scope(store._engine) as db:
            rec = db.get(FileRecord, file_id)
            if rec:
                rec.status = "ready"
                db.add(rec)

    monkeypatch.setattr("platform_api.routers.files.ingest_file_record", _fake_ingest)

    ing = client.post(
        f"/api/v1/workspaces/{ws_id}/files/{file_id}/ingest",
        cookies={"hermes_session": cookie},
    )
    assert ing.status_code == 200
    assert ing.json()["status"] == "ready"
