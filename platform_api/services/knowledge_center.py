"""Knowledge Center service — collections independent of File storage."""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from gateway.web.platform.database import session_scope
from gateway.web.platform.models import (
    FileRecord,
    KnowledgeBase,
    KnowledgeChunk,
    KnowledgeFile,
    Workspace,
)
from gateway.web.sandbox import enter_user_context
from platform_api.deps import get_store
from platform_api.services.chunking import chunk_text
from platform_api.services.extract import extract_text
from platform_api.services.knowledge import embed_text

logger = logging.getLogger("hermes.platform.knowledge_center")

CATEGORIES = frozenset({"trading", "tech", "learning", "other"})
STATUSES = frozenset({"processing", "ready", "failed"})


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _tokenize(text: str) -> set[str]:
    return set(re.findall(r"[a-zA-Z0-9\u4e00-\u9fff]+", text.lower()))


def assert_workspace(db: Session, workspace_id: str, user_id: str) -> Workspace:
    ws = db.get(Workspace, workspace_id)
    if not ws or ws.owner_id != user_id:
        raise LookupError("workspace not found")
    return ws


def base_to_dict(
    row: KnowledgeBase,
    *,
    file_count: int = 0,
    chunk_count: int = 0,
    files: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    return {
        "id": row.id,
        "user_id": row.user_id,
        "workspace_id": row.workspace_id,
        "tenant_id": row.tenant_id,
        "name": row.name,
        "description": row.description or "",
        "category": row.category,
        "status": row.status,
        "error_message": row.error_message,
        "file_count": file_count,
        "chunk_count": chunk_count,
        "files": files or [],
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def get_stats(db: Session, *, workspace_id: str, user_id: str) -> dict[str, Any]:
    bases = int(
        db.execute(
            select(func.count())
            .select_from(KnowledgeBase)
            .where(
                KnowledgeBase.workspace_id == workspace_id,
                KnowledgeBase.user_id == user_id,
            )
        ).scalar_one()
        or 0
    )
    docs = int(
        db.execute(
            select(func.count())
            .select_from(KnowledgeFile)
            .join(KnowledgeBase, KnowledgeBase.id == KnowledgeFile.knowledge_id)
            .where(
                KnowledgeBase.workspace_id == workspace_id,
                KnowledgeBase.user_id == user_id,
            )
        ).scalar_one()
        or 0
    )
    chunks = int(
        db.execute(
            select(func.count())
            .select_from(KnowledgeChunk)
            .where(
                KnowledgeChunk.workspace_id == workspace_id,
                KnowledgeChunk.user_id == user_id,
            )
        ).scalar_one()
        or 0
    )
    last = db.execute(
        select(func.max(KnowledgeBase.updated_at)).where(
            KnowledgeBase.workspace_id == workspace_id,
            KnowledgeBase.user_id == user_id,
        )
    ).scalar_one()
    return {
        "knowledge_count": bases,
        "document_count": docs,
        "chunk_count": chunks,
        "last_updated_at": last.isoformat() if last else None,
    }


def list_bases(
    db: Session, *, workspace_id: str, user_id: str
) -> list[dict[str, Any]]:
    rows = list(
        db.execute(
            select(KnowledgeBase)
            .where(
                KnowledgeBase.workspace_id == workspace_id,
                KnowledgeBase.user_id == user_id,
            )
            .order_by(KnowledgeBase.updated_at.desc())
        ).scalars().all()
    )
    out: list[dict[str, Any]] = []
    for row in rows:
        fc = int(
            db.execute(
                select(func.count())
                .select_from(KnowledgeFile)
                .where(KnowledgeFile.knowledge_id == row.id)
            ).scalar_one()
            or 0
        )
        cc = int(
            db.execute(
                select(func.count())
                .select_from(KnowledgeChunk)
                .where(KnowledgeChunk.knowledge_id == row.id)
            ).scalar_one()
            or 0
        )
        out.append(base_to_dict(row, file_count=fc, chunk_count=cc))
    return out


def get_base_detail(
    db: Session, *, knowledge_id: str, workspace_id: str, user_id: str
) -> dict[str, Any]:
    row = db.get(KnowledgeBase, knowledge_id)
    if not row or row.workspace_id != workspace_id or row.user_id != user_id:
        raise LookupError("not found")
    links = list(
        db.execute(
            select(KnowledgeFile, FileRecord)
            .join(FileRecord, FileRecord.id == KnowledgeFile.file_id)
            .where(KnowledgeFile.knowledge_id == knowledge_id)
        ).all()
    )
    files = [
        {
            "file_id": rec.id,
            "filename": rec.filename,
            "mime_type": rec.mime_type,
            "status": rec.status,
        }
        for _link, rec in links
    ]
    cc = int(
        db.execute(
            select(func.count())
            .select_from(KnowledgeChunk)
            .where(KnowledgeChunk.knowledge_id == knowledge_id)
        ).scalar_one()
        or 0
    )
    return base_to_dict(
        row, file_count=len(files), chunk_count=cc, files=files
    )


def _ingest_file_into_knowledge(
    db: Session,
    *,
    kb: KnowledgeBase,
    file_id: str,
    user_id: str,
) -> int:
    """Extract + chunk one file into knowledge_chunks. Returns chunk count."""
    rec = db.get(FileRecord, file_id)
    if not rec or rec.workspace_id != kb.workspace_id:
        raise ValueError(f"file not found: {file_id}")

    with enter_user_context(user_id):
        from gateway.web.sandbox import PathSandboxViolation, confine_path

        try:
            path = confine_path(rec.storage_key)
        except PathSandboxViolation as exc:
            raise ValueError(f"storage_key escapes workspace: {rec.storage_key}") from exc
        text = extract_text(path)
        pieces = chunk_text(text)

    for i, content in enumerate(pieces):
        emb = embed_text(content)
        db.add(
            KnowledgeChunk(
                tenant_id=kb.tenant_id,
                workspace_id=kb.workspace_id,
                user_id=user_id,
                knowledge_id=kb.id,
                file_id=file_id,
                chunk_index=i,
                content=content,
                embedding_json=json.dumps(emb),
                metadata_json={"filename": rec.filename},
            )
        )
    return len(pieces)


def create_knowledge_base(
    *,
    workspace_id: str,
    user_id: str,
    name: str,
    description: str = "",
    category: str = "other",
    file_ids: list[str],
) -> dict[str, Any]:
    name = (name or "").strip()
    if not name:
        raise ValueError("name is required")
    cat = (category or "other").strip().lower()
    if cat not in CATEGORIES:
        raise ValueError(f"invalid category: {category}")
    ids = [f for f in (file_ids or []) if f]
    if not ids:
        raise ValueError("file_ids is required")

    store = get_store()
    with session_scope(store._engine) as db:
        ws = assert_workspace(db, workspace_id, user_id)
        for fid in ids:
            rec = db.get(FileRecord, fid)
            if not rec or rec.workspace_id != workspace_id:
                raise ValueError(f"file not found: {fid}")

        kb = KnowledgeBase(
            tenant_id=ws.tenant_id,
            workspace_id=workspace_id,
            user_id=user_id,
            name=name,
            description=(description or "").strip() or None,
            category=cat,
            status="processing",
        )
        db.add(kb)
        db.flush()
        for fid in ids:
            db.add(KnowledgeFile(knowledge_id=kb.id, file_id=fid))
        db.flush()
        knowledge_id = kb.id

    # Process outside the create transaction so status updates are durable.
    return _run_index(knowledge_id=knowledge_id, user_id=user_id)


def _run_index(*, knowledge_id: str, user_id: str) -> dict[str, Any]:
    store = get_store()
    with session_scope(store._engine) as db:
        kb = db.get(KnowledgeBase, knowledge_id)
        if not kb or kb.user_id != user_id:
            raise LookupError("not found")
        kb.status = "processing"
        kb.error_message = None
        kb.updated_at = _utcnow()
        file_ids = [
            r.file_id
            for r in db.execute(
                select(KnowledgeFile).where(KnowledgeFile.knowledge_id == knowledge_id)
            ).scalars().all()
        ]
        db.execute(
            delete(KnowledgeChunk).where(KnowledgeChunk.knowledge_id == knowledge_id)
        )
        db.flush()

        total = 0
        try:
            if not file_ids:
                kb.status = "failed"
                kb.error_message = "no source files"
            else:
                for fid in file_ids:
                    total += _ingest_file_into_knowledge(
                        db, kb=kb, file_id=fid, user_id=user_id
                    )
                kb.status = "ready"
                kb.error_message = None
        except Exception as exc:
            logger.exception("knowledge index failed id=%s", knowledge_id)
            kb.status = "failed"
            kb.error_message = str(exc)[:500]
        kb.updated_at = _utcnow()
        db.flush()
        return get_base_detail(
            db,
            knowledge_id=knowledge_id,
            workspace_id=kb.workspace_id,
            user_id=user_id,
        )


def reindex_knowledge_base(
    *, knowledge_id: str, workspace_id: str, user_id: str
) -> dict[str, Any]:
    store = get_store()
    with store._session_factory() as db:
        kb = db.get(KnowledgeBase, knowledge_id)
        if not kb or kb.workspace_id != workspace_id or kb.user_id != user_id:
            raise LookupError("not found")
    return _run_index(knowledge_id=knowledge_id, user_id=user_id)


def delete_knowledge_base(
    *, knowledge_id: str, workspace_id: str, user_id: str
) -> None:
    store = get_store()
    with session_scope(store._engine) as db:
        kb = db.get(KnowledgeBase, knowledge_id)
        if not kb or kb.workspace_id != workspace_id or kb.user_id != user_id:
            raise LookupError("not found")
        db.delete(kb)


def search_knowledge_chunks(
    *,
    tenant_id: str,
    workspace_id: str,
    user_id: str,
    query: str,
    top_k: int = 5,
    knowledge_id: Optional[str] = None,
) -> list[dict[str, Any]]:
    """Keyword overlap search over ready Knowledge Center chunks."""
    store = get_store()
    q_tokens = _tokenize(query)
    with store._session_factory() as db:
        stmt = (
            select(KnowledgeChunk, KnowledgeBase.name, FileRecord.filename)
            .join(KnowledgeBase, KnowledgeBase.id == KnowledgeChunk.knowledge_id)
            .outerjoin(FileRecord, FileRecord.id == KnowledgeChunk.file_id)
            .where(
                KnowledgeChunk.tenant_id == tenant_id,
                KnowledgeChunk.workspace_id == workspace_id,
                KnowledgeChunk.user_id == user_id,
                KnowledgeBase.status == "ready",
            )
        )
        if knowledge_id:
            stmt = stmt.where(KnowledgeChunk.knowledge_id == knowledge_id)
        rows = db.execute(stmt).all()

    scored: list[tuple[float, Any, str, Optional[str]]] = []
    for chunk, kb_name, filename in rows:
        c_tokens = _tokenize(chunk.content)
        if not c_tokens:
            continue
        score = len(q_tokens & c_tokens) / max(len(q_tokens), 1)
        scored.append((score, chunk, kb_name, filename))
    scored.sort(key=lambda x: x[0], reverse=True)
    out: list[dict[str, Any]] = []
    for score, chunk, kb_name, filename in scored[:top_k]:
        if score <= 0:
            continue
        out.append({
            "chunk_id": chunk.id,
            "knowledge_id": chunk.knowledge_id,
            "knowledge_name": kb_name,
            "file_id": chunk.file_id,
            "filename": filename or "",
            "content": chunk.content[:2000],
            "score": round(score, 4),
        })
    return out


def reindex_or_fail_after_file_removed(*, knowledge_id: str, user_id: str) -> None:
    """After a source File is deleted: fail empty bases, else reindex remaining."""
    store = get_store()
    with store._session_factory() as db:
        kb = db.get(KnowledgeBase, knowledge_id)
        if not kb or kb.user_id != user_id:
            return
        n = int(
            db.execute(
                select(func.count())
                .select_from(KnowledgeFile)
                .where(KnowledgeFile.knowledge_id == knowledge_id)
            ).scalar_one()
            or 0
        )
    if n == 0:
        with session_scope(store._engine) as db:
            row = db.get(KnowledgeBase, knowledge_id)
            if not row:
                return
            row.status = "failed"
            row.error_message = "all source files removed"
            row.updated_at = _utcnow()
            db.execute(
                delete(KnowledgeChunk).where(KnowledgeChunk.knowledge_id == knowledge_id)
            )
        return
    _run_index(knowledge_id=knowledge_id, user_id=user_id)
