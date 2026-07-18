"""File ingestion: extract → chunk → store DocumentChunk (sync or worker)."""

from __future__ import annotations

from sqlalchemy import delete

from gateway.web.platform.database import session_scope
from gateway.web.platform.models import DocumentChunk, FileRecord
from gateway.web.sandbox import enter_user_context
from platform_api.deps import get_store
from platform_api.services.chunking import chunk_text
from platform_api.services.extract import extract_text
from platform_api.services.knowledge import store_chunks
from platform_api.services.object_store import open_local_path


def ingest_file_record(
    file_id: str, user_id: str, *, raise_on_error: bool = False
) -> None:
    """Idempotent ingest: replace chunks for ``file_id``, set ready/failed.

    Worker passes ``raise_on_error=True`` so failed jobs can be retried / DLQ'd.
    """
    store = get_store()
    with store._session_factory() as db:
        rec = db.get(FileRecord, file_id)
        if not rec:
            return
        tenant_id = rec.tenant_id
        workspace_id = rec.workspace_id
        storage_key = rec.storage_key

    with session_scope(store._engine) as db:
        row = db.get(FileRecord, file_id)
        if row:
            row.status = "processing"
            row.error_message = None

    try:
        with enter_user_context(user_id):
            with open_local_path(storage_key, workspace_id=workspace_id) as path:
                text = extract_text(path)
            pieces = chunk_text(text)
            # Idempotent: drop previous chunks before rewrite
            with session_scope(store._engine) as db:
                db.execute(
                    delete(DocumentChunk).where(DocumentChunk.file_id == file_id)
                )
            store_chunks(
                tenant_id=tenant_id,
                workspace_id=workspace_id,
                file_id=file_id,
                chunks=pieces,
            )
        with session_scope(store._engine) as db:
            row = db.get(FileRecord, file_id)
            if row:
                row.status = "ready"
                row.error_message = None
    except Exception as exc:
        with session_scope(store._engine) as db:
            row = db.get(FileRecord, file_id)
            if row:
                row.status = "failed"
                row.error_message = str(exc)[:500]
        if raise_on_error:
            raise
