"""File upload + knowledge search routes."""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any, List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import delete, select

from gateway.web.platform.models import (
    DocumentChunk,
    FileCategory,
    FileRecord,
    FileTag,
    FileTagLink,
    Workspace,
)
from gateway.web.sandbox import enter_user_context
from platform_api.deps import get_current_user_id, get_store
from platform_api.services.file_registry import file_record_dict, register_sandbox_file
from platform_api.services.ingest import ingest_file_record
from platform_api.services.knowledge import search_knowledge

router = APIRouter(prefix="/workspaces", tags=["files"])

_MAX_BYTES = 20 * 1024 * 1024
_ALLOWED_SUFFIXES = {".pdf", ".docx", ".xlsx", ".pptx", ".txt", ".md"}


class KnowledgeSearchBody(BaseModel):
    query: str
    top_k: int = 5


class CategoryBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)


class CategoryPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=128)
    sort_order: Optional[int] = None


class TagBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)


class FilePatchBody(BaseModel):
    category_id: Optional[str] = None
    tag_ids: Optional[List[str]] = None


@router.post("/{workspace_id}/files")
async def upload_files(
    workspace_id: str,
    files: List[UploadFile] = File(...),
    ingest: bool = Query(default=True),
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
            rec_dict = register_sandbox_file(
                workspace_id=ws.id,
                storage_key=storage_key,
                filename=safe_name,
                size_bytes=len(data),
                mime_type=uf.content_type,
                origin="platform",
                auto_ingest=ingest,
            )
            if ingest:
                pending_ingest.append(rec_dict["id"])
            results.append(rec_dict)
    for file_id in pending_ingest:
        ingest_file_record(file_id, user_id)
    if pending_ingest:
        store = get_store()
        with store._session_factory() as db:
            for i, r in enumerate(results):
                rec = db.get(FileRecord, r["id"])
                if rec:
                    results[i] = file_record_dict(rec, tag_ids=_tag_ids_for_file(db, r["id"]))
    return results


@router.get("/{workspace_id}/files")
def list_files(
    workspace_id: str,
    sort: str = Query(default="created_at"),
    order: str = Query(default="desc"),
    category_id: Optional[str] = Query(default=None),
    tag: Optional[str] = Query(default=None),
    user_id: str = Depends(get_current_user_id),
) -> List[dict[str, Any]]:
    _get_workspace(workspace_id, user_id)
    store = get_store()
    sort_col = {
        "created_at": FileRecord.created_at,
        "size": FileRecord.size_bytes,
        "name": FileRecord.filename,
    }.get(sort, FileRecord.created_at)
    descending = order.lower() != "asc"

    with store._session_factory() as db:
        stmt = select(FileRecord).where(FileRecord.workspace_id == workspace_id)
        if category_id:
            stmt = stmt.where(FileRecord.category_id == category_id)
        if tag:
            tag_row = db.execute(
                select(FileTag).where(
                    FileTag.workspace_id == workspace_id,
                    FileTag.name == tag,
                )
            ).scalar_one_or_none()
            if tag_row is None:
                return []
            stmt = stmt.join(FileTagLink, FileTagLink.file_id == FileRecord.id).where(
                FileTagLink.tag_id == tag_row.id
            )
        stmt = stmt.order_by(sort_col.desc() if descending else sort_col.asc())
        rows = db.execute(stmt).scalars().all()
        tag_map = _load_tag_ids(db, [r.id for r in rows])
        return [file_record_dict(r, tag_ids=tag_map.get(r.id, [])) for r in rows]


@router.patch("/{workspace_id}/files/{file_id}")
def patch_file(
    workspace_id: str,
    file_id: str,
    body: FilePatchBody,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    _get_workspace(workspace_id, user_id)
    store = get_store()
    from gateway.web.platform.database import session_scope

    with session_scope(store._engine) as db:
        rec = db.get(FileRecord, file_id)
        if not rec or rec.workspace_id != workspace_id:
            raise HTTPException(status_code=404, detail="not found")
        if body.category_id is not None:
            if body.category_id:
                cat = db.get(FileCategory, body.category_id)
                if not cat or cat.workspace_id != workspace_id:
                    raise HTTPException(status_code=400, detail="invalid category")
            rec.category_id = body.category_id or None
        if body.tag_ids is not None:
            db.execute(delete(FileTagLink).where(FileTagLink.file_id == file_id))
            for tid in body.tag_ids:
                tag = db.get(FileTag, tid)
                if not tag or tag.workspace_id != workspace_id:
                    raise HTTPException(status_code=400, detail="invalid tag")
                db.add(FileTagLink(file_id=file_id, tag_id=tid))
            db.flush()
        db.add(rec)
        tag_ids = _tag_ids_for_file(db, file_id)
        return file_record_dict(rec, tag_ids=tag_ids)


@router.post("/{workspace_id}/files/{file_id}/ingest")
def trigger_ingest(
    workspace_id: str,
    file_id: str,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    _get_workspace(workspace_id, user_id)
    store = get_store()
    with store._session_factory() as db:
        rec = db.get(FileRecord, file_id)
        if not rec or rec.workspace_id != workspace_id:
            raise HTTPException(status_code=404, detail="not found")
        suffix = Path(rec.filename).suffix.lower()
        if suffix not in _ALLOWED_SUFFIXES:
            raise HTTPException(status_code=400, detail="unsupported type for ingest")
        if rec.status == "ready":
            return file_record_dict(rec, tag_ids=_tag_ids_for_file(db, file_id))

    ingest_file_record(file_id, user_id)
    with store._session_factory() as db:
        rec = db.get(FileRecord, file_id)
        assert rec is not None
        return file_record_dict(rec, tag_ids=_tag_ids_for_file(db, file_id))


@router.get("/{workspace_id}/files/{file_id}/status")
def file_status(
    workspace_id: str,
    file_id: str,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    _get_workspace(workspace_id, user_id)
    store = get_store()
    with store._session_factory() as db:
        rec = db.get(FileRecord, file_id)
        if not rec or rec.workspace_id != workspace_id:
            raise HTTPException(status_code=404, detail="not found")
        return file_record_dict(rec, tag_ids=_tag_ids_for_file(db, file_id))


@router.delete("/{workspace_id}/files/{file_id}")
def delete_file(
    workspace_id: str,
    file_id: str,
    user_id: str = Depends(get_current_user_id),
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
            db.execute(delete(FileTagLink).where(FileTagLink.file_id == file_id))
            db.execute(delete(DocumentChunk).where(DocumentChunk.file_id == file_id))
            db.delete(rec)
    return {"status": "deleted"}


@router.get("/{workspace_id}/file-categories")
def list_categories(
    workspace_id: str,
    user_id: str = Depends(get_current_user_id),
) -> List[dict[str, Any]]:
    _get_workspace(workspace_id, user_id)
    store = get_store()
    with store._session_factory() as db:
        rows = db.execute(
            select(FileCategory)
            .where(FileCategory.workspace_id == workspace_id)
            .order_by(FileCategory.sort_order, FileCategory.name)
        ).scalars()
        return [_category_dict(c) for c in rows]


@router.post("/{workspace_id}/file-categories")
def create_category(
    workspace_id: str,
    body: CategoryBody,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    ws = _get_workspace(workspace_id, user_id)
    store = get_store()
    from gateway.web.platform.database import session_scope

    with session_scope(store._engine) as db:
        existing = db.execute(
            select(FileCategory).where(
                FileCategory.workspace_id == workspace_id,
                FileCategory.name == body.name.strip(),
            )
        ).scalar_one_or_none()
        if existing:
            raise HTTPException(status_code=409, detail="category exists")
        cat = FileCategory(
            workspace_id=workspace_id,
            name=body.name.strip(),
        )
        db.add(cat)
        db.flush()
        return _category_dict(cat)


@router.patch("/{workspace_id}/file-categories/{category_id}")
def patch_category(
    workspace_id: str,
    category_id: str,
    body: CategoryPatch,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    _get_workspace(workspace_id, user_id)
    store = get_store()
    from gateway.web.platform.database import session_scope

    with session_scope(store._engine) as db:
        cat = db.get(FileCategory, category_id)
        if not cat or cat.workspace_id != workspace_id:
            raise HTTPException(status_code=404, detail="not found")
        if body.name is not None:
            cat.name = body.name.strip()
        if body.sort_order is not None:
            cat.sort_order = body.sort_order
        db.add(cat)
        return _category_dict(cat)


@router.delete("/{workspace_id}/file-categories/{category_id}")
def delete_category(
    workspace_id: str,
    category_id: str,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, str]:
    _get_workspace(workspace_id, user_id)
    store = get_store()
    from gateway.web.platform.database import session_scope

    with session_scope(store._engine) as db:
        cat = db.get(FileCategory, category_id)
        if not cat or cat.workspace_id != workspace_id:
            raise HTTPException(status_code=404, detail="not found")
        for rec in db.execute(
            select(FileRecord).where(FileRecord.category_id == category_id)
        ).scalars():
            rec.category_id = None
            db.add(rec)
        db.delete(cat)
    return {"status": "deleted"}


@router.get("/{workspace_id}/file-tags")
def list_tags(
    workspace_id: str,
    user_id: str = Depends(get_current_user_id),
) -> List[dict[str, Any]]:
    _get_workspace(workspace_id, user_id)
    store = get_store()
    with store._session_factory() as db:
        rows = db.execute(
            select(FileTag)
            .where(FileTag.workspace_id == workspace_id)
            .order_by(FileTag.name)
        ).scalars()
        return [_tag_dict(t) for t in rows]


@router.post("/{workspace_id}/file-tags")
def create_tag(
    workspace_id: str,
    body: TagBody,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    _get_workspace(workspace_id, user_id)
    store = get_store()
    from gateway.web.platform.database import session_scope

    with session_scope(store._engine) as db:
        existing = db.execute(
            select(FileTag).where(
                FileTag.workspace_id == workspace_id,
                FileTag.name == body.name.strip(),
            )
        ).scalar_one_or_none()
        if existing:
            return _tag_dict(existing)
        tag = FileTag(workspace_id=workspace_id, name=body.name.strip())
        db.add(tag)
        db.flush()
        return _tag_dict(tag)


@router.delete("/{workspace_id}/file-tags/{tag_id}")
def delete_tag(
    workspace_id: str,
    tag_id: str,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, str]:
    _get_workspace(workspace_id, user_id)
    store = get_store()
    from gateway.web.platform.database import session_scope

    with session_scope(store._engine) as db:
        tag = db.get(FileTag, tag_id)
        if not tag or tag.workspace_id != workspace_id:
            raise HTTPException(status_code=404, detail="not found")
        db.execute(delete(FileTagLink).where(FileTagLink.tag_id == tag_id))
        db.delete(tag)
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


def _category_dict(cat: FileCategory) -> dict[str, Any]:
    return {
        "id": cat.id,
        "name": cat.name,
        "sort_order": cat.sort_order,
        "created_at": cat.created_at.timestamp(),
    }


def _tag_dict(tag: FileTag) -> dict[str, Any]:
    return {
        "id": tag.id,
        "name": tag.name,
        "created_at": tag.created_at.timestamp(),
    }


def _load_tag_ids(db, file_ids: list[str]) -> dict[str, list[str]]:
    if not file_ids:
        return {}
    rows = db.execute(
        select(FileTagLink.file_id, FileTagLink.tag_id).where(
            FileTagLink.file_id.in_(file_ids)
        )
    ).all()
    out: dict[str, list[str]] = {}
    for fid, tid in rows:
        out.setdefault(fid, []).append(tid)
    return out


def _tag_ids_for_file(db, file_id: str) -> list[str]:
    return [
        tid
        for (_, tid) in db.execute(
            select(FileTagLink.file_id, FileTagLink.tag_id).where(
                FileTagLink.file_id == file_id
            )
        ).all()
    ]
