"""File upload + knowledge search routes."""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any, List, Optional

import mimetypes

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select

from gateway.web.platform.models import (
    DocumentChunk,
    FileCategory,
    FileFolder,
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
_DOC_SUFFIXES = {".pdf", ".docx", ".xlsx", ".pptx", ".txt", ".md"}
_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}
_ALLOWED_SUFFIXES = _DOC_SUFFIXES | _IMAGE_SUFFIXES


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


class FolderBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)
    parent_id: Optional[str] = None


class FolderPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=128)


class FilePatchBody(BaseModel):
    category_id: Optional[str] = None
    folder_id: Optional[str] = None
    tag_ids: Optional[List[str]] = None
    filename: Optional[str] = Field(default=None, min_length=1, max_length=512)


def _is_image_filename(name: str) -> bool:
    return Path(name).suffix.lower() in _IMAGE_SUFFIXES


def _is_document_filename(name: str) -> bool:
    return Path(name).suffix.lower() in _DOC_SUFFIXES


@router.post("/{workspace_id}/files")
async def upload_files(
    workspace_id: str,
    files: List[UploadFile] = File(...),
    ingest: bool = Query(default=True),
    folder_id: Optional[str] = Query(default=None),
    user_id: str = Depends(get_current_user_id),
) -> List[dict[str, Any]]:
    ws = _get_workspace(workspace_id, user_id)
    if folder_id:
        _require_folder(workspace_id, folder_id)
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
            # Images are archive-only — no RAG extractors for binary images.
            want_ingest = bool(ingest) and not _is_image_filename(safe_name)
            rec_dict = register_sandbox_file(
                workspace_id=ws.id,
                storage_key=storage_key,
                filename=safe_name,
                size_bytes=len(data),
                mime_type=uf.content_type,
                origin="platform",
                auto_ingest=want_ingest,
                folder_id=folder_id,
            )
            if want_ingest:
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
    folder_id: Optional[str] = Query(default=None),
    kind: Optional[str] = Query(default=None),
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
    kind_norm = (kind or "").strip().lower() or None
    if kind_norm and kind_norm not in ("image", "document"):
        raise HTTPException(status_code=400, detail="kind must be 'image' or 'document'")

    with store._session_factory() as db:
        stmt = select(FileRecord).where(FileRecord.workspace_id == workspace_id)
        if category_id:
            stmt = stmt.where(FileRecord.category_id == category_id)
        # ``folder_id=`` (empty) → root only; omitted → all folders.
        if folder_id is not None:
            if folder_id == "":
                stmt = stmt.where(FileRecord.folder_id.is_(None))
            else:
                stmt = stmt.where(FileRecord.folder_id == folder_id)
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
        rows = list(db.execute(stmt).scalars().all())
        if kind_norm == "image":
            rows = [r for r in rows if _is_image_filename(r.filename)]
        elif kind_norm == "document":
            rows = [r for r in rows if _is_document_filename(r.filename)]
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
        if body.folder_id is not None:
            if body.folder_id:
                folder = db.get(FileFolder, body.folder_id)
                if not folder or folder.workspace_id != workspace_id:
                    raise HTTPException(status_code=400, detail="invalid folder")
                rec.folder_id = body.folder_id
            else:
                rec.folder_id = None
        if body.tag_ids is not None:
            db.execute(delete(FileTagLink).where(FileTagLink.file_id == file_id))
            for tid in body.tag_ids:
                tag = db.get(FileTag, tid)
                if not tag or tag.workspace_id != workspace_id:
                    raise HTTPException(status_code=400, detail="invalid tag")
                db.add(FileTagLink(file_id=file_id, tag_id=tid))
            db.flush()
        if body.filename is not None:
            safe = Path(body.filename).name.strip()
            if not safe or safe in (".", ".."):
                raise HTTPException(status_code=400, detail="invalid filename")
            suffix = Path(safe).suffix.lower()
            if suffix not in _ALLOWED_SUFFIXES:
                raise HTTPException(
                    status_code=400, detail=f"unsupported type: {suffix or '(none)'}"
                )
            rec.filename = safe
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
        if suffix not in _DOC_SUFFIXES:
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


@router.get("/{workspace_id}/files/{file_id}/content")
def download_file_content(
    workspace_id: str,
    file_id: str,
    user_id: str = Depends(get_current_user_id),
) -> FileResponse:
    """Stream file bytes for in-app preview (images / markdown / PDF)."""
    _get_workspace(workspace_id, user_id)
    store = get_store()
    with enter_user_context(user_id):
        from gateway.web.sandbox import get_user_workspace

        with store._session_factory() as db:
            rec = db.get(FileRecord, file_id)
            if not rec or rec.workspace_id != workspace_id:
                raise HTTPException(status_code=404, detail="not found")
            storage_key = rec.storage_key
            filename = rec.filename
            mime_type = rec.mime_type

        root = get_user_workspace().resolve()
        path = (root / storage_key).resolve()
        # 防止 storage_key 越权跳出用户沙箱
        if not path.is_relative_to(root) or not path.is_file():
            raise HTTPException(status_code=404, detail="not found")
        media = (
            mime_type
            or mimetypes.guess_type(filename)[0]
            or "application/octet-stream"
        )
        return FileResponse(
            path,
            media_type=media,
            filename=filename,
            content_disposition_type="inline",
        )


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


@router.get("/{workspace_id}/file-folders")
def list_folders(
    workspace_id: str,
    parent_id: Optional[str] = Query(default=None),
    user_id: str = Depends(get_current_user_id),
) -> List[dict[str, Any]]:
    """List folders. Default: all folders. ``parent_id=`` limits to root children."""
    _get_workspace(workspace_id, user_id)
    store = get_store()
    with store._session_factory() as db:
        stmt = select(FileFolder).where(FileFolder.workspace_id == workspace_id)
        if parent_id is not None:
            if parent_id == "":
                stmt = stmt.where(FileFolder.parent_id.is_(None))
            else:
                stmt = stmt.where(FileFolder.parent_id == parent_id)
        rows = db.execute(stmt.order_by(FileFolder.name)).scalars().all()
        folder_ids = [f.id for f in rows]
        counts: dict[str, int] = {}
        if folder_ids:
            # Direct files only; UI adds immediate subfolder counts client-side.
            count_rows = db.execute(
                select(FileRecord.folder_id, func.count(FileRecord.id))
                .where(
                    FileRecord.workspace_id == workspace_id,
                    FileRecord.folder_id.in_(folder_ids),
                )
                .group_by(FileRecord.folder_id)
            ).all()
            counts = {str(fid): int(n) for fid, n in count_rows if fid}
        return [
            _folder_dict(f, file_count=counts.get(f.id, 0)) for f in rows
        ]


@router.post("/{workspace_id}/file-folders")
def create_folder(
    workspace_id: str,
    body: FolderBody,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    _get_workspace(workspace_id, user_id)
    name = body.name.strip()
    parent_id = body.parent_id or None
    if parent_id:
        _require_folder(workspace_id, parent_id)
    store = get_store()
    from gateway.web.platform.database import session_scope

    with session_scope(store._engine) as db:
        clash = _find_folder_name_clash(db, workspace_id, parent_id, name)
        if clash:
            raise HTTPException(status_code=409, detail="folder name exists")
        folder = FileFolder(
            workspace_id=workspace_id,
            parent_id=parent_id,
            name=name,
        )
        db.add(folder)
        db.flush()
        return _folder_dict(folder)


@router.patch("/{workspace_id}/file-folders/{folder_id}")
def patch_folder(
    workspace_id: str,
    folder_id: str,
    body: FolderPatch,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    _get_workspace(workspace_id, user_id)
    store = get_store()
    from gateway.web.platform.database import session_scope

    with session_scope(store._engine) as db:
        folder = db.get(FileFolder, folder_id)
        if not folder or folder.workspace_id != workspace_id:
            raise HTTPException(status_code=404, detail="not found")
        if body.name is not None:
            name = body.name.strip()
            clash = _find_folder_name_clash(
                db, workspace_id, folder.parent_id, name, exclude_id=folder_id,
            )
            if clash:
                raise HTTPException(status_code=409, detail="folder name exists")
            folder.name = name
        db.add(folder)
        return _folder_dict(folder)


@router.delete("/{workspace_id}/file-folders/{folder_id}")
def delete_folder(
    workspace_id: str,
    folder_id: str,
    force: bool = Query(default=False),
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    """Delete a folder. Non-empty → 409 with counts unless ``force=true``."""
    _get_workspace(workspace_id, user_id)
    store = get_store()
    from gateway.web.platform.database import session_scope

    with enter_user_context(user_id):
        from gateway.web.sandbox import get_user_workspace

        with session_scope(store._engine) as db:
            folder = db.get(FileFolder, folder_id)
            if not folder or folder.workspace_id != workspace_id:
                raise HTTPException(status_code=404, detail="not found")

            descendant_ids = _collect_descendant_folder_ids(db, workspace_id, folder_id)
            all_folder_ids = [folder_id, *descendant_ids]
            file_rows = list(
                db.execute(
                    select(FileRecord).where(
                        FileRecord.workspace_id == workspace_id,
                        FileRecord.folder_id.in_(all_folder_ids),
                    )
                ).scalars()
            )
            file_count = len(file_rows)
            folder_count = len(descendant_ids)

            if (file_count or folder_count) and not force:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "folder_not_empty",
                        "file_count": file_count,
                        "folder_count": folder_count,
                        "message": (
                            f"folder contains {file_count} file(s) and "
                            f"{folder_count} subfolder(s)"
                        ),
                    },
                )

            workspace_root = get_user_workspace()
            for rec in file_rows:
                path = workspace_root / rec.storage_key
                if path.is_file():
                    path.unlink()
                db.execute(delete(FileTagLink).where(FileTagLink.file_id == rec.id))
                db.execute(
                    delete(DocumentChunk).where(DocumentChunk.file_id == rec.id)
                )
                db.delete(rec)

            # Children first so FK parent links stay valid until removed.
            for child_id in reversed(descendant_ids):
                child = db.get(FileFolder, child_id)
                if child:
                    db.delete(child)
            db.delete(folder)

    return {
        "status": "deleted",
        "file_count": file_count,
        "folder_count": folder_count,
    }


def _collect_descendant_folder_ids(
    db, workspace_id: str, root_id: str
) -> list[str]:
    """BFS: all nested folder ids under ``root_id`` (not including root)."""
    found: list[str] = []
    queue = [root_id]
    while queue:
        parent = queue.pop(0)
        children = list(
            db.execute(
                select(FileFolder.id).where(
                    FileFolder.workspace_id == workspace_id,
                    FileFolder.parent_id == parent,
                )
            ).scalars()
        )
        for cid in children:
            found.append(cid)
            queue.append(cid)
    return found


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

    name = body.name.strip()
    with session_scope(store._engine) as db:
        existing = db.execute(
            select(FileTag).where(
                FileTag.workspace_id == workspace_id,
                func.lower(FileTag.name) == name.lower(),
            )
        ).scalar_one_or_none()
        if existing:
            return _tag_dict(existing)
        tag = FileTag(workspace_id=workspace_id, name=name)
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


def _folder_dict(
    folder: FileFolder,
    *,
    file_count: int = 0,
) -> dict[str, Any]:
    return {
        "id": folder.id,
        "name": folder.name,
        "parent_id": folder.parent_id,
        "created_at": folder.created_at.timestamp(),
        "file_count": file_count,
    }


def _require_folder(workspace_id: str, folder_id: str) -> FileFolder:
    store = get_store()
    with store._session_factory() as db:
        folder = db.get(FileFolder, folder_id)
        if not folder or folder.workspace_id != workspace_id:
            raise HTTPException(status_code=400, detail="invalid folder")
        return folder


def _find_folder_name_clash(
    db,
    workspace_id: str,
    parent_id: Optional[str],
    name: str,
    *,
    exclude_id: Optional[str] = None,
) -> Optional[FileFolder]:
    stmt = select(FileFolder).where(
        FileFolder.workspace_id == workspace_id,
        FileFolder.name == name,
    )
    if parent_id is None:
        stmt = stmt.where(FileFolder.parent_id.is_(None))
    else:
        stmt = stmt.where(FileFolder.parent_id == parent_id)
    if exclude_id:
        stmt = stmt.where(FileFolder.id != exclude_id)
    return db.execute(stmt).scalar_one_or_none()


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
