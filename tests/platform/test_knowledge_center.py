"""Knowledge Center: CRUD, isolation, delete-kb keeps File, delete-file cleans chunks."""

from __future__ import annotations

from pathlib import Path

from gateway.web.sandbox import enter_user_context, get_user_workspace
from platform_api.deps import get_store
from tests.platform.conftest import bind_upstream_key, register_user


def _setup(client, mock_upstream_key, email: str = "kb@example.com"):
    del mock_upstream_key
    body, _ = register_user(client, email=email)
    bind_upstream_key(client)
    return body["user"]["user_id"], body["workspace"]["id"]


def _upload_txt(client, wid: str, name: str, text: bytes) -> str:
    up = client.post(
        f"/api/v1/workspaces/{wid}/files",
        files={"files": (name, text, "text/plain")},
    )
    assert up.status_code == 200, up.text
    return up.json()[0]["id"]


def test_create_list_stats_search(client, mock_upstream_key):
    _uid, wid = _setup(client, mock_upstream_key)
    fid = _upload_txt(
        client, wid, "alpha.txt", b"Hermes knowledge center alpha beta gamma"
    )

    created = client.post(
        f"/api/v1/workspaces/{wid}/knowledge-bases",
        json={
            "name": "Trading notes",
            "description": "MVP collection",
            "category": "trading",
            "file_ids": [fid],
        },
    )
    assert created.status_code == 200, created.text
    kb = created.json()
    assert kb["status"] == "ready"
    assert kb["name"] == "Trading notes"
    assert kb["category"] == "trading"
    assert kb["chunk_count"] >= 1
    assert kb["file_count"] == 1

    listed = client.get(f"/api/v1/workspaces/{wid}/knowledge-bases")
    assert listed.status_code == 200
    assert len(listed.json()["items"]) == 1

    stats = client.get(f"/api/v1/workspaces/{wid}/knowledge-bases/stats")
    assert stats.status_code == 200
    body = stats.json()
    assert body["knowledge_count"] == 1
    assert body["document_count"] == 1
    assert body["chunk_count"] >= 1
    assert body["last_updated_at"]

    search = client.post(
        f"/api/v1/workspaces/{wid}/knowledge-bases/search",
        json={"query": "alpha gamma", "top_k": 3},
    )
    assert search.status_code == 200, search.text
    hits = search.json()["results"]
    assert hits
    assert any("alpha" in h["content"].lower() for h in hits)


def test_delete_knowledge_keeps_file(client, mock_upstream_key):
    user_id, wid = _setup(client, mock_upstream_key, email="keep@example.com")
    fid = _upload_txt(client, wid, "keep.txt", b"Keep this file on disk forever")
    created = client.post(
        f"/api/v1/workspaces/{wid}/knowledge-bases",
        json={"name": "Temp KB", "file_ids": [fid]},
    )
    kid = created.json()["id"]

    deleted = client.delete(f"/api/v1/workspaces/{wid}/knowledge-bases/{kid}")
    assert deleted.status_code == 200

    gone = client.get(f"/api/v1/workspaces/{wid}/knowledge-bases/{kid}")
    assert gone.status_code == 404

    # File record still listed
    files = client.get(f"/api/v1/workspaces/{wid}/files")
    assert files.status_code == 200
    assert any(f["id"] == fid for f in files.json())

    # Disk blob still present
    with enter_user_context(user_id):
        store = get_store()
        with store._session_factory() as db:
            from gateway.web.platform.models import FileRecord

            rec = db.get(FileRecord, fid)
            assert rec is not None
            path = get_user_workspace() / Path(rec.storage_key)
            # storage_key may already be relative under workspace
            from gateway.web.sandbox import confine_path

            path = confine_path(rec.storage_key)
            assert path.is_file()


def test_cross_user_isolation(client, mock_upstream_key):
    _uid_a, wid_a = _setup(client, mock_upstream_key, email="kba@example.com")
    fid = _upload_txt(client, wid_a, "secret.txt", b"secret knowledge payload")
    created = client.post(
        f"/api/v1/workspaces/{wid_a}/knowledge-bases",
        json={"name": "Private", "file_ids": [fid]},
    )
    assert created.status_code == 200
    kid = created.json()["id"]

    # Switch to user B
    client.cookies.clear()
    _uid_b, wid_b = _setup(client, mock_upstream_key, email="kbb@example.com")

    assert (
        client.get(f"/api/v1/workspaces/{wid_a}/knowledge-bases/{kid}").status_code
        == 404
    )
    assert (
        client.delete(f"/api/v1/workspaces/{wid_a}/knowledge-bases/{kid}").status_code
        == 404
    )
    search = client.post(
        f"/api/v1/workspaces/{wid_a}/knowledge-bases/search",
        json={"query": "secret"},
    )
    assert search.status_code == 404

    # Own workspace search must not see A's chunks
    own = client.post(
        f"/api/v1/workspaces/{wid_b}/knowledge-bases/search",
        json={"query": "secret"},
    )
    assert own.status_code == 200
    assert own.json()["results"] == []


def test_delete_file_cleans_knowledge_chunks(client, mock_upstream_key):
    _uid, wid = _setup(client, mock_upstream_key, email="rmfile@example.com")
    f1 = _upload_txt(client, wid, "one.txt", b"first document unique token zebra")
    f2 = _upload_txt(client, wid, "two.txt", b"second document unique token yak")
    created = client.post(
        f"/api/v1/workspaces/{wid}/knowledge-bases",
        json={"name": "Multi", "file_ids": [f1, f2]},
    )
    assert created.status_code == 200, created.text
    kid = created.json()["id"]
    assert created.json()["status"] == "ready"

    rm = client.delete(f"/api/v1/workspaces/{wid}/files/{f1}")
    assert rm.status_code == 200

    detail = client.get(f"/api/v1/workspaces/{wid}/knowledge-bases/{kid}")
    assert detail.status_code == 200
    body = detail.json()
    assert body["status"] == "ready"
    assert body["file_count"] == 1

    search = client.post(
        f"/api/v1/workspaces/{wid}/knowledge-bases/search",
        json={"query": "zebra", "knowledge_id": kid},
    )
    assert search.status_code == 200
    # zebra was only in deleted file
    assert not any("zebra" in h["content"].lower() for h in search.json()["results"])

    search2 = client.post(
        f"/api/v1/workspaces/{wid}/knowledge-bases/search",
        json={"query": "yak", "knowledge_id": kid},
    )
    assert any("yak" in h["content"].lower() for h in search2.json()["results"])


def test_delete_last_file_marks_failed(client, mock_upstream_key):
    _uid, wid = _setup(client, mock_upstream_key, email="empty@example.com")
    fid = _upload_txt(client, wid, "only.txt", b"lonely document")
    created = client.post(
        f"/api/v1/workspaces/{wid}/knowledge-bases",
        json={"name": "Solo", "file_ids": [fid]},
    )
    kid = created.json()["id"]

    assert client.delete(f"/api/v1/workspaces/{wid}/files/{fid}").status_code == 200
    detail = client.get(f"/api/v1/workspaces/{wid}/knowledge-bases/{kid}")
    assert detail.status_code == 200
    assert detail.json()["status"] == "failed"


def test_reindex(client, mock_upstream_key):
    _uid, wid = _setup(client, mock_upstream_key, email="reidx@example.com")
    fid = _upload_txt(client, wid, "r.txt", b"reindex me please")
    created = client.post(
        f"/api/v1/workspaces/{wid}/knowledge-bases",
        json={"name": "R", "file_ids": [fid]},
    )
    kid = created.json()["id"]
    before = created.json()["chunk_count"]

    again = client.post(f"/api/v1/workspaces/{wid}/knowledge-bases/{kid}/reindex")
    assert again.status_code == 200, again.text
    assert again.json()["status"] == "ready"
    assert again.json()["chunk_count"] == before
