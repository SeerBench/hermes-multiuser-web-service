"""Usage Center service — platform activity / cost ledger (not new-api billing)."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from gateway.web.platform.database import session_scope
from gateway.web.platform.models import UsageRecord, Workspace
from platform_api.deps import get_store

logger = logging.getLogger("hermes.platform.usage")

USAGE_TYPES = frozenset({"chat", "model", "skill", "knowledge", "tool"})
_SECRET_META_KEYS = frozenset({
    "api_key",
    "authorization",
    "password",
    "token",
    "secret",
    "access_token",
    "refresh_token",
})
_META_MAX_BYTES = 2048
_STR_MAX = 128


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _clip(value: Optional[str], max_len: int = _STR_MAX) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text[:max_len]


def sanitize_metadata(metadata: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """Strip secret keys and truncate JSON payload size."""
    if not metadata or not isinstance(metadata, dict):
        return None
    clean: dict[str, Any] = {}
    for key, val in metadata.items():
        k = str(key).lower()
        if k in _SECRET_META_KEYS or any(s in k for s in ("api_key", "password", "secret")):
            continue
        if isinstance(val, str) and len(val) > 512:
            clean[str(key)[:64]] = val[:512]
        else:
            clean[str(key)[:64]] = val
    try:
        raw = json.dumps(clean, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return None
    if len(raw.encode("utf-8")) > _META_MAX_BYTES:
        return {"truncated": True, "keys": list(clean.keys())[:20]}
    return clean or None


def estimate_cost(
    *,
    model: Optional[str],
    input_tokens: int,
    output_tokens: int,
) -> float:
    """MVP: default 0; optional env pricing is out of scope — keep hook."""
    _ = (model, input_tokens, output_tokens)
    return 0.0


def record_to_dict(row: UsageRecord) -> dict[str, Any]:
    return {
        "id": row.id,
        "tenant_id": row.tenant_id,
        "workspace_id": row.workspace_id,
        "user_id": row.user_id,
        "type": row.type,
        "model": row.model,
        "skill_name": row.skill_name,
        "knowledge_id": row.knowledge_id,
        "tool_name": row.tool_name,
        "session_id": row.session_id,
        "input_tokens": row.input_tokens,
        "output_tokens": row.output_tokens,
        "total_tokens": row.total_tokens,
        "cost": row.cost,
        "metadata": row.metadata_json or {},
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


def create_record(
    *,
    user_id: str,
    type: str,
    workspace_id: Optional[str] = None,
    tenant_id: Optional[str] = None,
    model: Optional[str] = None,
    skill_name: Optional[str] = None,
    knowledge_id: Optional[str] = None,
    tool_name: Optional[str] = None,
    session_id: Optional[str] = None,
    input_tokens: int = 0,
    output_tokens: int = 0,
    total_tokens: Optional[int] = None,
    cost: Optional[float] = None,
    metadata: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Persist one usage row. Resolves workspace/tenant from user if omitted."""
    usage_type = (type or "").strip().lower()
    if usage_type not in USAGE_TYPES:
        raise ValueError(f"invalid usage type: {type}")

    inp = max(0, int(input_tokens or 0))
    out = max(0, int(output_tokens or 0))
    total = int(total_tokens) if total_tokens is not None else inp + out
    total = max(0, total)
    model_s = _clip(model)
    cost_v = float(cost) if cost is not None else estimate_cost(
        model=model_s, input_tokens=inp, output_tokens=out
    )

    store = get_store()
    with session_scope(store._engine) as db:
        tid = tenant_id
        wid = workspace_id
        if not wid or not tid:
            ws = None
            if wid:
                ws = db.get(Workspace, wid)
            if not ws:
                # Default workspace for user
                ws = db.execute(
                    select(Workspace)
                    .where(Workspace.owner_id == user_id)
                    .order_by(Workspace.created_at.asc())
                    .limit(1)
                ).scalar_one_or_none()
            if not ws or ws.owner_id != user_id:
                raise LookupError("workspace not found")
            wid = ws.id
            tid = ws.tenant_id

        row = UsageRecord(
            tenant_id=tid,
            workspace_id=wid,
            user_id=user_id,
            type=usage_type,
            model=model_s,
            skill_name=_clip(skill_name),
            knowledge_id=_clip(knowledge_id, 36),
            tool_name=_clip(tool_name),
            session_id=_clip(session_id),
            input_tokens=inp,
            output_tokens=out,
            total_tokens=total,
            cost=max(0.0, cost_v),
            metadata_json=sanitize_metadata(metadata),
        )
        db.add(row)
        db.flush()
        return record_to_dict(row)


def _period_bounds(kind: str) -> tuple[datetime, datetime]:
    now = _utcnow()
    if kind == "today":
        start = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
    elif kind == "month":
        start = datetime(now.year, now.month, 1, tzinfo=timezone.utc)
    else:
        raise ValueError(kind)
    return start, now


def _agg_for_range(
    db: Session, *, user_id: str, start: datetime, end: datetime
) -> dict[str, Any]:
    row = db.execute(
        select(
            func.count(),
            func.coalesce(func.sum(UsageRecord.total_tokens), 0),
            func.coalesce(func.sum(UsageRecord.cost), 0.0),
        ).where(
            UsageRecord.user_id == user_id,
            UsageRecord.created_at >= start,
            UsageRecord.created_at <= end,
        )
    ).one()
    return {
        "requests": int(row[0] or 0),
        "tokens": int(row[1] or 0),
        "cost": float(row[2] or 0.0),
    }


def get_summary(*, user_id: str) -> dict[str, Any]:
    store = get_store()
    with store._session_factory() as db:
        today_start, now = _period_bounds("today")
        month_start, _ = _period_bounds("month")
        return {
            "today": _agg_for_range(db, user_id=user_id, start=today_start, end=now),
            "month": _agg_for_range(db, user_id=user_id, start=month_start, end=now),
        }


def get_trend(*, user_id: str, days: int = 7) -> dict[str, Any]:
    days = 30 if days >= 30 else 7
    store = get_store()
    now = _utcnow()
    start = datetime(now.year, now.month, now.day, tzinfo=timezone.utc) - timedelta(
        days=days - 1
    )
    with store._session_factory() as db:
        rows = db.execute(
            select(UsageRecord).where(
                UsageRecord.user_id == user_id,
                UsageRecord.created_at >= start,
            )
        ).scalars().all()

    buckets: dict[str, dict[str, Any]] = {}
    for i in range(days):
        d = (start + timedelta(days=i)).date().isoformat()
        buckets[d] = {"date": d, "requests": 0, "tokens": 0}

    for row in rows:
        if not row.created_at:
            continue
        key = row.created_at.astimezone(timezone.utc).date().isoformat()
        if key not in buckets:
            continue
        buckets[key]["requests"] += 1
        buckets[key]["tokens"] += int(row.total_tokens or 0)

    return {"days": days, "points": [buckets[k] for k in sorted(buckets.keys())]}


def get_by_model(*, user_id: str, days: int = 30) -> dict[str, Any]:
    days = max(1, min(int(days or 30), 90))
    start = _utcnow() - timedelta(days=days)
    store = get_store()
    with store._session_factory() as db:
        rows = db.execute(
            select(
                UsageRecord.model,
                func.count(),
                func.coalesce(func.sum(UsageRecord.total_tokens), 0),
                func.coalesce(func.sum(UsageRecord.cost), 0.0),
            )
            .where(
                UsageRecord.user_id == user_id,
                UsageRecord.created_at >= start,
                UsageRecord.model.is_not(None),
            )
            .group_by(UsageRecord.model)
            .order_by(func.sum(UsageRecord.total_tokens).desc())
        ).all()
    items = [
        {
            "model": r[0] or "",
            "requests": int(r[1] or 0),
            "tokens": int(r[2] or 0),
            "cost": float(r[3] or 0.0),
        }
        for r in rows
    ]
    return {"days": days, "items": items}


def get_by_skill(*, user_id: str, days: int = 30) -> dict[str, Any]:
    days = max(1, min(int(days or 30), 90))
    start = _utcnow() - timedelta(days=days)
    store = get_store()
    with store._session_factory() as db:
        rows = db.execute(
            select(
                UsageRecord.skill_name,
                func.count(),
                func.max(UsageRecord.created_at),
            )
            .where(
                UsageRecord.user_id == user_id,
                UsageRecord.created_at >= start,
                UsageRecord.type == "skill",
                UsageRecord.skill_name.is_not(None),
            )
            .group_by(UsageRecord.skill_name)
            .order_by(func.count().desc())
        ).all()
    items = [
        {
            "skill_name": r[0] or "",
            "requests": int(r[1] or 0),
            "last_used_at": r[2].isoformat() if r[2] else None,
        }
        for r in rows
    ]
    return {"days": days, "items": items}


def list_logs(
    *,
    user_id: str,
    limit: int = 50,
    offset: int = 0,
    type: Optional[str] = None,
) -> dict[str, Any]:
    limit = max(1, min(int(limit or 50), 200))
    offset = max(0, int(offset or 0))
    store = get_store()
    with store._session_factory() as db:
        stmt = select(UsageRecord).where(UsageRecord.user_id == user_id)
        count_stmt = select(func.count()).select_from(UsageRecord).where(
            UsageRecord.user_id == user_id
        )
        if type:
            t = type.strip().lower()
            if t in USAGE_TYPES:
                stmt = stmt.where(UsageRecord.type == t)
                count_stmt = count_stmt.where(UsageRecord.type == t)
        total = int(db.execute(count_stmt).scalar_one() or 0)
        rows = list(
            db.execute(
                stmt.order_by(UsageRecord.created_at.desc())
                .limit(limit)
                .offset(offset)
            ).scalars().all()
        )
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "items": [record_to_dict(r) for r in rows],
    }
