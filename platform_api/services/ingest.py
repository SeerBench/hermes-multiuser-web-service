"""Synchronous file ingestion (MVP — worker can async later)."""

from __future__ import annotations

from pathlib import Path

from gateway.web.platform.database import session_scope
from gateway.web.platform.models import FileRecord
from gateway.web.sandbox import enter_user_context
from platform_api.deps import get_store
from platform_api.services.chunking import chunk_text
from platform_api.services.extract import extract_text
from platform_api.services.knowledge import store_chunks


def ingest_file_record(file_id: str, user_id: str) -> None:
    store = get_store()
    with store._session_factory() as db:
        rec = db.get(FileRecord, file_id)
        if not rec:
            return
        tenant_id = rec.tenant_id
        workspace_id = rec.workspace_id
        storage_key = rec.storage_key
    try:
        with enter_user_context(user_id):
            from gateway.web.sandbox import PathSandboxViolation, confine_path

            # 禁止毒化 storage_key 读出工作区外文件再写入知识库
            try:
                path = confine_path(storage_key)
            except PathSandboxViolation as exc:
                raise ValueError(f"storage_key escapes workspace: {storage_key}") from exc
            text = extract_text(path)
            pieces = chunk_text(text)
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
