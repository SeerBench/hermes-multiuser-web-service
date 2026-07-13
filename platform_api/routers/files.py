"""File upload + knowledge search routes."""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any, List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import delete, select

from gateway.web.platform.models import DocumentChunk, FileRecord, Workspace
from gateway.web.sandbox import enter_user_context
from platform_api.deps import get_current_user_id, get_store
from platform_api.services.ingest import ingest_file_record
from platform_api.services.knowledge import search_knowledge

router = APIRouter(prefix="/workspaces", tags=["files"])

_MAX_BYTES = 20 * 1024 * 1024
_ALLOWED_SUFFIXES = {".pdf", ".docx", ".xlsx", ".pptx", ".txt", ".md"}


class KnowledgeSearchBody(BaseModel):
    query: str
    top_k: int = 5


@router.post("/{workspace_id}/files")
async def upload_files(
    workspace_id: str,
    files: List[UploadFile] = File(...),
    user_id: str = Depends(get_current_user_id),
) -> List[dict[str, Any]]:
    ws = _get_workspace(workspace_id, user_id)
    results: list[dict[str, Any]] = []
    pending_ingest: list[str] = []
    with enter_user_context(user_id):
        from gateway.web.sandbox import get_user_workspace

        upload_dir = get_user_workspace() / "uploads"
        upload_dir.mkdir(parents=True, exist_ok=True)

        for uf in files:
            suffix = Path(uf.filename or "").suffix.lower()
            if suffix not in _ALLOWED_SUFFIXES:
                raise HTTPException(status_code=400, detail=f"unsupported type: {suffix}")
            data = await uf.read()
            if len(data) > _MAX_BYTES:
                raise HTTPException(status_code=400, detail="file too large")
            file_id = str(uuid.uuid4())
            safe_name = Path(uf.filename or "upload").name
            dest = upload_dir / f"{file_id}_{safe_name}"
            dest.write_bytes(data)
            storage_key = str(dest.relative_to(get_user_workspace()))
            rec_dict = _create_file_record(
                ws, file_id, safe_name, uf.content_type, len(data), storage_key
            )
            pending_ingest.append(rec_dict["id"])
            results.append(rec_dict)
    for file_id in pending_ingest:
        ingest_file_record(file_id, user_id)
    # 刷新 ingestion 后的状态（创建记录时仍为 pending）
    store = get_store()
    with store._session_factory() as db:
        for i, fid in enumerate(pending_ingest):
            rec = db.get(FileRecord, fid)
            if rec:
                results[i] = _file_dict(rec)
    return results


@router.get("/{workspace_id}/files")
def list_files(workspace_id: str, user_id: str = Depends(get_current_user_id)) -> List[dict[str, Any]]:
    _get_workspace(workspace_id, user_id)
    store = get_store()
    with store._session_factory() as db:
        rows = db.execute(
            select(FileRecord)
            .where(FileRecord.workspace_id == workspace_id)
            .order_by(FileRecord.created_at.desc())
        ).scalars()
        return [_file_dict(r) for r in rows]


@router.get("/{workspace_id}/files/{file_id}/status")
def file_status(
    workspace_id: str, file_id: str, user_id: str = Depends(get_current_user_id)
) -> dict[str, Any]:
    _get_workspace(workspace_id, user_id)
    store = get_store()
    with store._session_factory() as db:
        rec = db.get(FileRecord, file_id)
        if not rec or rec.workspace_id != workspace_id:
            raise HTTPException(status_code=404, detail="not found")
        return _file_dict(rec)


@router.delete("/{workspace_id}/files/{file_id}")
def delete_file(
    workspace_id: str, file_id: str, user_id: str = Depends(get_current_user_id)
) -> dict[str, str]:
    _get_workspace(workspace_id, user_id)
    store = get_store()
    from gateway.web.platform.database import session_scope

    with enter_user_context(user_id):
        from gateway.web.sandbox import get_user_workspace

        with session_scope(store._engine) as db:
            rec = db.get(FileRecord, file_id)
            if not rec or rec.workspace_id != workspace_id:
                raise HTTPException(status_code=404, detail="not found")
            path = get_user_workspace() / rec.storage_key
            if path.is_file():
                path.unlink()
            db.execute(delete(DocumentChunk).where(DocumentChunk.file_id == file_id))
            db.delete(rec)
    return {"status": "deleted"}


@router.post("/{workspace_id}/knowledge/search")
def knowledge_search(
    workspace_id: str,
    body: KnowledgeSearchBody,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    ws = _get_workspace(workspace_id, user_id)
    hits = search_knowledge(
        tenant_id=ws.tenant_id,
        workspace_id=workspace_id,
        query=body.query,
        top_k=body.top_k,
    )
    return {"results": hits}


def _get_workspace(workspace_id: str, user_id: str) -> Workspace:
    store = get_store()
    with store._session_factory() as db:
        ws = db.get(Workspace, workspace_id)
        if not ws or ws.owner_id != user_id:
            raise HTTPException(status_code=404, detail="not found")
        return ws


def _create_file_record(
    ws: Workspace,
    file_id: str,
    filename: str,
    mime: Optional[str],
    size: int,
    storage_key: str,
) -> dict[str, Any]:
    from gateway.web.platform.database import session_scope

    store = get_store()
    with session_scope(store._engine) as db:
        rec = FileRecord(
            id=file_id,
            tenant_id=ws.tenant_id,
            workspace_id=ws.id,
            filename=filename,
            mime_type=mime,
            size_bytes=size,
            storage_key=storage_key,
            status="pending",
        )
        db.add(rec)
        db.flush()
        return _file_dict(rec)


def _file_dict(rec: FileRecord) -> dict[str, Any]:
    return {
        "id": rec.id,
        "filename": rec.filename,
        "mime_type": rec.mime_type,
        "size_bytes": rec.size_bytes,
        "status": rec.status,
        "error_message": rec.error_message,
        "created_at": rec.created_at.timestamp(),
    }
