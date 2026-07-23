"""Public share snapshots — create (auth) + anonymous read."""

from __future__ import annotations

from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from platform_api.deps import get_current_user_id
from platform_api.services import shares as shares_svc

router = APIRouter(prefix="/shares", tags=["shares"])


class ShareTurnIn(BaseModel):
    role: Literal["user", "assistant"]
    text: str = Field(min_length=1, max_length=100_000)


class CreateShareIn(BaseModel):
    kind: Literal["reply", "conversation"]
    turns: list[ShareTurnIn] = Field(min_length=1, max_length=500)
    title: Optional[str] = Field(default=None, max_length=512)
    source_session_id: Optional[str] = Field(default=None, max_length=128)


@router.post("")
def create_share(
    body: CreateShareIn,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    return shares_svc.create_share(
        user_id=user_id,
        kind=body.kind,
        turns=[t.model_dump() for t in body.turns],
        title=body.title,
        source_session_id=body.source_session_id,
    )


@router.get("/{token}")
def get_share(token: str) -> dict[str, Any]:
    """Anonymous read-only snapshot — no auth cookie required."""
    return shares_svc.get_public_share(token)
