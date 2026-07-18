"""Platform API must not unlink/read storage_key paths outside the user workspace."""

from __future__ import annotations

from gateway.web.platform.database import session_scope
from gateway.web.platform.models import FileRecord
from gateway.web.sandbox import enter_user_context, ensure_workspace
from platform_api.deps import get_store
from tests.platform.conftest import bind_upstream_key, register_user


def test_delete_file_ignores_traversing_storage_key(client, mock_upstream_key):
    """Malicious storage_key must not delete a sibling user's file."""
    reg_a, _ = register_user(client, email="own@example.com")
    user_a = reg_a["user"]["user_id"]
    ws_a = reg_a["workspace"]["id"]
    bind_upstream_key(client)

    # Victim file in another workspace directory.
    bob_ws = ensure_workspace("u_victim_bob")
    victim = bob_ws / "memories" / "MEMORY.md"
    victim.parent.mkdir(parents=True, exist_ok=True)
    victim.write_text("bob private", encoding="utf-8")

    up = client.post(
        f"/api/v1/workspaces/{ws_a}/files",
        files={"files": ("note.txt", b"alice note", "text/plain")},
    )
    assert up.status_code == 200, up.text
    file_id = up.json()[0]["id"]

    store = get_store()
    with session_scope(store._engine) as db:
        rec = db.get(FileRecord, file_id)
        assert rec is not None
        # Point storage_key at Bob's file via path traversal.
        rec.storage_key = f"../u_victim_bob/memories/MEMORY.md"

    delete = client.delete(f"/api/v1/workspaces/{ws_a}/files/{file_id}")
    assert delete.status_code == 200, delete.text

    # Victim file must still exist; only the DB row is gone.
    assert victim.is_file()
    assert victim.read_text(encoding="utf-8") == "bob private"
    with session_scope(store._engine) as db:
        assert db.get(FileRecord, file_id) is None

    # Sanity: alice's real upload is under her workspace (may still exist
    # if delete skipped unlink for the poisoned key — that's fine).
    with enter_user_context(user_a):
        pass
