"""Memory Center service — structured memory CRUD + md projection.

DB (``memory_items``) is the source of truth. Approved ``active`` rows are
projected into per-user ``memories/MEMORY.md`` / ``USER.md`` so Hermes
``MemoryStore`` keeps working without touching ``MemoryManager``.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from gateway.web.platform.models import MemoryItem, Workspace
from gateway.web.sandbox import enter_user_context, get_user_workspace
from tools.memory_tool import ENTRY_DELIMITER

logger = logging.getLogger("hermes.platform.memory_center")

CATEGORIES = frozenset(
    {"profile", "preference", "project", "skill", "workflow", "knowledge"}
)
STATUSES = frozenset({"active", "pending", "archived"})
SOURCES = frozenset({"conversation", "manual", "import", "agent_tool"})

# Match MemoryStore defaults — truncate by importance when projecting.
_MEMORY_CHAR_LIMIT = 2200
_USER_CHAR_LIMIT = 1375

_MEMORY_FILE = "memories/MEMORY.md"
_PROFILE_FILE = "memories/USER.md"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def item_to_dict(row: MemoryItem) -> dict[str, Any]:
    return {
        "id": row.id,
        "user_id": row.user_id,
        "tenant_id": row.tenant_id,
        "workspace_id": row.workspace_id,
        "category": row.category,
        "content": row.content,
        "source": row.source,
        "confidence": row.confidence,
        "status": row.status,
        "importance": row.importance,
        "source_ref": row.source_ref,
        "raw_excerpt": row.raw_excerpt,
        "ai_summary": row.ai_summary,
        "metadata": row.metadata_json or {},
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def assert_workspace(db: Session, workspace_id: str, user_id: str) -> Workspace:
    ws = db.get(Workspace, workspace_id)
    if not ws or ws.owner_id != user_id:
        raise LookupError("workspace not found")
    return ws


def list_items(
    db: Session,
    *,
    workspace_id: str,
    q: Optional[str] = None,
    category: Optional[str] = None,
    status: Optional[str] = None,
    sort: str = "updated_at",
) -> list[MemoryItem]:
    stmt = select(MemoryItem).where(MemoryItem.workspace_id == workspace_id)
    if category:
        stmt = stmt.where(MemoryItem.category == category)
    if status:
        stmt = stmt.where(MemoryItem.status == status)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                MemoryItem.content.ilike(like),
                MemoryItem.source_ref.ilike(like),
                MemoryItem.ai_summary.ilike(like),
            )
        )
    if sort == "created_at":
        stmt = stmt.order_by(MemoryItem.created_at.desc())
    elif sort == "importance":
        stmt = stmt.order_by(MemoryItem.importance.desc(), MemoryItem.updated_at.desc())
    else:
        stmt = stmt.order_by(MemoryItem.updated_at.desc())
    return list(db.execute(stmt).scalars().all())


def get_stats(db: Session, *, workspace_id: str) -> dict[str, Any]:
    total = db.execute(
        select(func.count())
        .select_from(MemoryItem)
        .where(
            MemoryItem.workspace_id == workspace_id,
            MemoryItem.status != "archived",
        )
    ).scalar_one()
    pending = db.execute(
        select(func.count())
        .select_from(MemoryItem)
        .where(
            MemoryItem.workspace_id == workspace_id,
            MemoryItem.status == "pending",
        )
    ).scalar_one()
    last = db.execute(
        select(func.max(MemoryItem.updated_at)).where(
            MemoryItem.workspace_id == workspace_id
        )
    ).scalar_one()
    return {
        "total": int(total or 0),
        "pending": int(pending or 0),
        "last_updated_at": last.isoformat() if last else None,
    }


def create_item(
    db: Session,
    *,
    workspace: Workspace,
    user_id: str,
    category: str,
    content: str,
    source: str = "manual",
    status: str = "active",
    confidence: float = 1.0,
    importance: int = 50,
    source_ref: Optional[str] = None,
    raw_excerpt: Optional[str] = None,
    ai_summary: Optional[str] = None,
    metadata: Optional[dict[str, Any]] = None,
) -> MemoryItem:
    cat = (category or "knowledge").strip().lower()
    if cat not in CATEGORIES:
        raise ValueError(f"invalid category: {category}")
    src = (source or "manual").strip().lower()
    if src not in SOURCES:
        raise ValueError(f"invalid source: {source}")
    st = (status or "active").strip().lower()
    if st not in STATUSES:
        raise ValueError(f"invalid status: {status}")
    text = (content or "").strip()
    if not text:
        raise ValueError("content is required")

    row = MemoryItem(
        tenant_id=workspace.tenant_id,
        workspace_id=workspace.id,
        user_id=user_id,
        category=cat,
        content=text,
        source=src,
        status=st,
        confidence=max(0.0, min(1.0, float(confidence))),
        importance=max(0, min(100, int(importance))),
        source_ref=source_ref,
        raw_excerpt=raw_excerpt,
        ai_summary=ai_summary,
        metadata_json=metadata or {},
    )
    db.add(row)
    db.flush()
    return row


def update_item(
    db: Session,
    row: MemoryItem,
    *,
    content: Optional[str] = None,
    category: Optional[str] = None,
    confidence: Optional[float] = None,
    importance: Optional[int] = None,
    source_ref: Optional[str] = None,
    raw_excerpt: Optional[str] = None,
    ai_summary: Optional[str] = None,
    metadata: Optional[dict[str, Any]] = None,
    status: Optional[str] = None,
) -> MemoryItem:
    if content is not None:
        text = content.strip()
        if not text:
            raise ValueError("content is required")
        row.content = text
    if category is not None:
        cat = category.strip().lower()
        if cat not in CATEGORIES:
            raise ValueError(f"invalid category: {category}")
        row.category = cat
    if confidence is not None:
        row.confidence = max(0.0, min(1.0, float(confidence)))
    if importance is not None:
        row.importance = max(0, min(100, int(importance)))
    if source_ref is not None:
        row.source_ref = source_ref
    if raw_excerpt is not None:
        row.raw_excerpt = raw_excerpt
    if ai_summary is not None:
        row.ai_summary = ai_summary
    if metadata is not None:
        row.metadata_json = metadata
    if status is not None:
        st = status.strip().lower()
        if st not in STATUSES:
            raise ValueError(f"invalid status: {status}")
        row.status = st
    row.updated_at = _utcnow()
    db.add(row)
    db.flush()
    return row


def _fit_entries(entries: list[tuple[int, str]], limit: int) -> list[str]:
    """Keep highest-importance entries that fit under ``limit`` chars."""
    chosen: list[str] = []
    size = 0
    for _imp, text in sorted(entries, key=lambda x: (-x[0],)):
        add = len(text) if not chosen else len(ENTRY_DELIMITER) + len(text)
        if size + add > limit:
            continue
        chosen.append(text)
        size += add
    return chosen


def project_active_memories(db: Session, *, workspace_id: str, user_id: str) -> None:
    """Rewrite MEMORY.md / USER.md from active rows for this workspace."""
    rows = list(
        db.execute(
            select(MemoryItem).where(
                MemoryItem.workspace_id == workspace_id,
                MemoryItem.status == "active",
            )
        ).scalars().all()
    )
    profile_entries = [
        (r.importance, r.content.strip())
        for r in rows
        if r.category == "profile" and r.content.strip()
    ]
    memory_entries = [
        (r.importance, r.content.strip())
        for r in rows
        if r.category != "profile" and r.content.strip()
    ]
    profile_text = ENTRY_DELIMITER.join(_fit_entries(profile_entries, _USER_CHAR_LIMIT))
    memory_text = ENTRY_DELIMITER.join(_fit_entries(memory_entries, _MEMORY_CHAR_LIMIT))
    if profile_text:
        profile_text += "\n"
    if memory_text:
        memory_text += "\n"

    with enter_user_context(user_id):
        ws = get_user_workspace()
        assert ws is not None
        mem_dir = ws / "memories"
        mem_dir.mkdir(parents=True, exist_ok=True)
        (ws / _MEMORY_FILE).write_text(memory_text, encoding="utf-8")
        (ws / _PROFILE_FILE).write_text(profile_text, encoding="utf-8")


def _split_entries(raw: str) -> list[str]:
    if not raw or not raw.strip():
        return []
    if ENTRY_DELIMITER in raw:
        return [e.strip() for e in raw.split(ENTRY_DELIMITER) if e.strip()]
    # Single-entry or legacy freeform paragraph
    return [raw.strip()]


def migrate_from_files(
    db: Session,
    *,
    workspace: Workspace,
    user_id: str,
) -> dict[str, int]:
    """Import § entries from MEMORY.md / USER.md. Idempotent by content match."""
    existing = {
        r.content.strip()
        for r in db.execute(
            select(MemoryItem).where(MemoryItem.workspace_id == workspace.id)
        ).scalars().all()
    }
    imported = 0
    with enter_user_context(user_id):
        ws = get_user_workspace()
        assert ws is not None
        mem_path = Path(ws / _MEMORY_FILE)
        user_path = Path(ws / _PROFILE_FILE)
        mem_raw = mem_path.read_text(encoding="utf-8") if mem_path.is_file() else ""
        user_raw = user_path.read_text(encoding="utf-8") if user_path.is_file() else ""

    for text in _split_entries(mem_raw):
        if text in existing:
            continue
        create_item(
            db,
            workspace=workspace,
            user_id=user_id,
            category="knowledge",
            content=text,
            source="import",
            status="active",
            confidence=1.0,
        )
        existing.add(text)
        imported += 1

    for text in _split_entries(user_raw):
        if text in existing:
            continue
        create_item(
            db,
            workspace=workspace,
            user_id=user_id,
            category="profile",
            content=text,
            source="import",
            status="active",
            confidence=1.0,
        )
        existing.add(text)
        imported += 1

    if imported:
        project_active_memories(db, workspace_id=workspace.id, user_id=user_id)
    return {"imported": imported}


def create_pending_from_agent(
    db: Session,
    *,
    workspace: Workspace,
    user_id: str,
    content: str,
    category: str = "knowledge",
    confidence: float = 0.8,
    source_ref: Optional[str] = None,
    raw_excerpt: Optional[str] = None,
) -> MemoryItem:
    """Agent tool path — always pending, never silent permanent save."""
    return create_item(
        db,
        workspace=workspace,
        user_id=user_id,
        category=category,
        content=content,
        source="agent_tool",
        status="pending",
        confidence=confidence,
        source_ref=source_ref,
        raw_excerpt=raw_excerpt,
        ai_summary=content,
    )
