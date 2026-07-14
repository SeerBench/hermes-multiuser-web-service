"""Shared file registration for chat uploads and platform API."""

from __future__ import annotations

import uuid
from typing import Any, Optional

from gateway.web.platform.database import session_scope
from gateway.web.platform.models import FileRecord, Workspace
from platform_api.deps import get_store


def register_sandbox_file(
    *,
    workspace_id: str,
    storage_key: str,
    filename: str,
    size_bytes: int,
    mime_type: Optional[str] = None,
    origin: str = "chat",
    auto_ingest: bool = False,
) -> dict[str, Any]:
    """Create a FileRecord pointing at an existing sandbox path.

    Chat attachments use ``auto_ingest=False`` and get ``status='skipped'``.
    Platform uploads with ingest enabled start at ``pending``.
    """
    file_id = str(uuid.uuid4())
    initial_status = "pending" if auto_ingest else "skipped"
    store = get_store()
    with session_scope(store._engine) as db:
        ws = db.get(Workspace, workspace_id)
        if ws is None:
            raise ValueError(f"unknown workspace: {workspace_id}")
        rec = FileRecord(
            id=file_id,
            tenant_id=ws.tenant_id,
            workspace_id=ws.id,
            filename=filename,
            mime_type=mime_type,
            size_bytes=size_bytes,
            storage_key=storage_key,
            origin=origin,
            status=initial_status,
        )
        db.add(rec)
        db.flush()
        return file_record_dict(rec, tag_ids=[])


def file_record_dict(rec: FileRecord, *, tag_ids: list[str]) -> dict[str, Any]:
    return {
        "id": rec.id,
        "filename": rec.filename,
        "mime_type": rec.mime_type,
        "size_bytes": rec.size_bytes,
        "storage_key": rec.storage_key,
        "origin": rec.origin,
        "category_id": rec.category_id,
        "tag_ids": tag_ids,
        "status": rec.status,
        "error_message": rec.error_message,
        "created_at": rec.created_at.timestamp(),
    }
