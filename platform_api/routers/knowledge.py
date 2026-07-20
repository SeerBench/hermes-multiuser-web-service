"""Knowledge Center API — collections independent of File storage lifecycle."""

from __future__ import annotations

from typing import Any, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from platform_api.deps import get_current_user_id, get_store
from platform_api.services import knowledge_center as kc

router = APIRouter(prefix="/workspaces", tags=["knowledge"])


class CreateKnowledgeBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: str = ""
    category: str = "other"
    file_ids: List[str] = Field(..., min_length=1)


class KnowledgeSearchBody(BaseModel):
    query: str = Field(..., min_length=1)
    top_k: int = Field(default=5, ge=1, le=20)
    knowledge_id: Optional[str] = None


def _assert_workspace(workspace_id: str, user_id: str) -> None:
    store = get_store()
    with store._session_factory() as db:
        try:
            kc.assert_workspace(db, workspace_id, user_id)
        except LookupError:
            raise HTTPException(status_code=404, detail="not found") from None


@router.get("/{workspace_id}/knowledge-bases/stats")
def knowledge_stats(
    workspace_id: str,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    _assert_workspace(workspace_id, user_id)
    store = get_store()
    with store._session_factory() as db:
        return kc.get_stats(db, workspace_id=workspace_id, user_id=user_id)


@router.get("/{workspace_id}/knowledge-bases")
def list_knowledge_bases(
    workspace_id: str,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    _assert_workspace(workspace_id, user_id)
    store = get_store()
    with store._session_factory() as db:
        items = kc.list_bases(db, workspace_id=workspace_id, user_id=user_id)
    return {"items": items}


@router.post("/{workspace_id}/knowledge-bases")
def create_knowledge_base(
    workspace_id: str,
    body: CreateKnowledgeBody,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    _assert_workspace(workspace_id, user_id)
    try:
        result = kc.create_knowledge_base(
            workspace_id=workspace_id,
            user_id=user_id,
            name=body.name,
            description=body.description,
            category=body.category,
            file_ids=body.file_ids,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except LookupError:
        raise HTTPException(status_code=404, detail="not found") from None

    store = get_store()
    store.audit(
        user_id,
        "knowledge.create",
        target_type="knowledge_base",
        target_id=result.get("id"),
        name=body.name,
        file_count=len(body.file_ids),
    )
    return result


@router.get("/{workspace_id}/knowledge-bases/{knowledge_id}")
def get_knowledge_base(
    workspace_id: str,
    knowledge_id: str,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    _assert_workspace(workspace_id, user_id)
    store = get_store()
    with store._session_factory() as db:
        try:
            return kc.get_base_detail(
                db,
                knowledge_id=knowledge_id,
                workspace_id=workspace_id,
                user_id=user_id,
            )
        except LookupError:
            raise HTTPException(status_code=404, detail="not found") from None


@router.delete("/{workspace_id}/knowledge-bases/{knowledge_id}")
def delete_knowledge_base(
    workspace_id: str,
    knowledge_id: str,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, str]:
    _assert_workspace(workspace_id, user_id)
    try:
        kc.delete_knowledge_base(
            knowledge_id=knowledge_id,
            workspace_id=workspace_id,
            user_id=user_id,
        )
    except LookupError:
        raise HTTPException(status_code=404, detail="not found") from None
    get_store().audit(
        user_id,
        "knowledge.delete",
        target_type="knowledge_base",
        target_id=knowledge_id,
    )
    return {"status": "deleted"}


@router.post("/{workspace_id}/knowledge-bases/{knowledge_id}/reindex")
def reindex_knowledge_base(
    workspace_id: str,
    knowledge_id: str,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    _assert_workspace(workspace_id, user_id)
    try:
        result = kc.reindex_knowledge_base(
            knowledge_id=knowledge_id,
            workspace_id=workspace_id,
            user_id=user_id,
        )
    except LookupError:
        raise HTTPException(status_code=404, detail="not found") from None
    get_store().audit(
        user_id,
        "knowledge.reindex",
        target_type="knowledge_base",
        target_id=knowledge_id,
    )
    return result


@router.post("/{workspace_id}/knowledge-bases/search")
def search_knowledge_bases(
    workspace_id: str,
    body: KnowledgeSearchBody,
    user_id: str = Depends(get_current_user_id),
) -> dict[str, Any]:
    _assert_workspace(workspace_id, user_id)
    store = get_store()
    with store._session_factory() as db:
        from gateway.web.platform.models import Workspace

        ws = db.get(Workspace, workspace_id)
        if not ws:
            raise HTTPException(status_code=404, detail="not found")
        tenant_id = ws.tenant_id

    results = kc.search_knowledge_chunks(
        tenant_id=tenant_id,
        workspace_id=workspace_id,
        user_id=user_id,
        query=body.query,
        top_k=body.top_k,
        knowledge_id=body.knowledge_id,
    )
    return {"results": results, "query": body.query}
