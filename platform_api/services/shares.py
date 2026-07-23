"""Create / fetch immutable share snapshots."""

from __future__ import annotations

import secrets
from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy import select

from gateway.web.platform.models import ShareSnapshot
from platform_api.deps import get_store

ALLOWED_KINDS = frozenset({"reply", "conversation"})
ALLOWED_ROLES = frozenset({"user", "assistant"})
MAX_TURNS = 500
MAX_TEXT_LEN = 100_000
MAX_TITLE_LEN = 512


def _sanitize_turns(turns: list[Any]) -> list[dict[str, str]]:
    if not isinstance(turns, list) or not turns:
        raise HTTPException(status_code=422, detail="turns must be a non-empty list")
    if len(turns) > MAX_TURNS:
        raise HTTPException(status_code=422, detail="too many turns")
    out: list[dict[str, str]] = []
    for item in turns:
        if not isinstance(item, dict):
            raise HTTPException(status_code=422, detail="invalid turn")
        role = str(item.get("role") or "").strip().lower()
        text = str(item.get("text") or "").strip()
        if role not in ALLOWED_ROLES:
            raise HTTPException(status_code=422, detail="invalid turn role")
        if not text:
            raise HTTPException(status_code=422, detail="turn text required")
        if len(text) > MAX_TEXT_LEN:
            raise HTTPException(status_code=422, detail="turn text too long")
        out.append({"role": role, "text": text})
    return out


def create_share(
    *,
    user_id: str,
    kind: str,
    turns: list[Any],
    title: Optional[str] = None,
    source_session_id: Optional[str] = None,
) -> dict[str, Any]:
    kind_norm = (kind or "").strip().lower()
    if kind_norm not in ALLOWED_KINDS:
        raise HTTPException(status_code=422, detail="invalid kind")
    clean_turns = _sanitize_turns(turns)
    title_clean = (title or "").strip() or None
    if title_clean and len(title_clean) > MAX_TITLE_LEN:
        title_clean = title_clean[:MAX_TITLE_LEN]

    store = get_store()
    user = store.get_user(user_id)
    if not user:
        raise HTTPException(status_code=401, detail="unauthorized")
    tenant_id = str(user.get("tenant_id") or "")
    if not tenant_id:
        raise HTTPException(status_code=500, detail="tenant missing")

    token = secrets.token_urlsafe(16)
    payload = {
        "kind": kind_norm,
        "title": title_clean,
        "turns": clean_turns,
    }
    row = ShareSnapshot(
        token=token,
        owner_user_id=user_id,
        tenant_id=tenant_id,
        kind=kind_norm,
        title=title_clean,
        payload_json=payload,
        source_session_id=(source_session_id or None),
    )
    with store._session_factory() as db:
        db.add(row)
        db.commit()
        db.refresh(row)

    return {
        "token": token,
        "url_path": f"#/share/{token}",
        "kind": kind_norm,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


def get_public_share(token: str) -> dict[str, Any]:
    tok = (token or "").strip()
    if not tok or len(tok) > 64:
        raise HTTPException(status_code=404, detail="not found")
    store = get_store()
    with store._session_factory() as db:
        row = db.execute(
            select(ShareSnapshot).where(ShareSnapshot.token == tok)
        ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="not found")
    payload = row.payload_json if isinstance(row.payload_json, dict) else {}
    turns = payload.get("turns") if isinstance(payload.get("turns"), list) else []
    return {
        "kind": row.kind,
        "title": row.title or payload.get("title"),
        "turns": turns,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }
