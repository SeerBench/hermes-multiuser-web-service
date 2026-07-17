"""Auth routes: register, login, logout, bind-key, me, profile."""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Cookie, HTTPException, Request, Response
from pydantic import BaseModel, EmailStr, Field

from gateway.web.key_storage import KeyVaultError
from gateway.web.platform.store import PlatformStore
from gateway.web.users import InvalidCredentialsError, UserStoreError
from platform_api.deps import get_settings, get_store, get_vault
from platform_api.services.rate_limit import get_login_rate_limiter

router = APIRouter(prefix="/auth", tags=["auth"])


def _client_ip(request: Request) -> str:
    """Best-effort client IP (honour first X-Forwarded-For hop behind nginx)."""
    forwarded = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if forwarded:
        return forwarded
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def _login_rate_key(email: str, request: Request) -> str:
    return f"login:{email.strip().lower()}:{_client_ip(request)}"


class RegisterBody(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class LoginBody(BaseModel):
    email: EmailStr
    password: str


class BindKeyBody(BaseModel):
    api_key: str = Field(min_length=8)


class ProfilePatchBody(BaseModel):
    nickname: Optional[str] = Field(default=None, max_length=64)
    email: Optional[EmailStr] = None
    avatar_url: Optional[str] = Field(default=None, max_length=350_000)
    clear_avatar: bool = False


class ChangePasswordBody(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


def _issue_cookie(response: Response, store: PlatformStore, user_id: str, key_enc: str) -> None:
    settings = get_settings()
    vault = get_vault()
    token = store.create_web_session(
        user_id,
        key_enc or "",
        ttl_seconds=settings.cookie_ttl_seconds,
    )
    response.set_cookie(
        key=settings.session_cookie,
        value=token,
        max_age=settings.cookie_ttl_seconds,
        path="/",
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
    )


def _require_session_user(hermes_session: Optional[str]) -> tuple[PlatformStore, dict[str, Any]]:
    if not hermes_session:
        raise HTTPException(status_code=401, detail="unauthorized")
    store = get_store()
    if not isinstance(store, PlatformStore):
        raise HTTPException(status_code=503, detail="platform store required")
    try:
        session = store.verify_web_session(hermes_session)
    except InvalidCredentialsError as exc:
        raise HTTPException(status_code=401, detail="unauthorized") from exc
    user = store.get_user(session["user_id"])
    if not user:
        raise HTTPException(status_code=401, detail="unauthorized")
    return store, user


@router.post("/register")
def register(body: RegisterBody, response: Response) -> dict[str, Any]:
    store = get_store()
    vault = get_vault()
    try:
        result = store.register_user(
            body.email,
            body.password,
            encrypt_key_fn=vault.encrypt,
        )
    except UserStoreError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    user = result["user"]
    key_enc = store.get_user_upstream_key_enc(user["user_id"]) or ""
    _issue_cookie(response, store, user["user_id"], key_enc)
    return {
        "user": user,
        "workspace": result["workspace"],
        "upstream_status": user["upstream_status"],
        "provision_mode": result["provision_mode"],
    }


@router.post("/login")
def login(body: LoginBody, response: Response, request: Request) -> dict[str, Any]:
    store = get_store()
    limiter = get_login_rate_limiter()
    rate_key = _login_rate_key(body.email, request)
    if limiter.is_blocked(rate_key):
        raise HTTPException(
            status_code=429,
            detail="too many login attempts; try again later",
            headers={"Retry-After": "300"},
        )
    try:
        result = store.authenticate_user(body.email, body.password)
    except InvalidCredentialsError as exc:
        limiter.record_failure(rate_key)
        raise HTTPException(status_code=401, detail="invalid credentials") from exc

    limiter.clear(rate_key)
    user = result["user"]
    key_enc = store.get_user_upstream_key_enc(user["user_id"]) or ""
    _issue_cookie(response, store, user["user_id"], key_enc)
    return {
        "user": user,
        "workspace": result.get("workspace"),
        "upstream_status": user["upstream_status"],
    }


@router.post("/logout")
def logout(
    response: Response,
    hermes_session: Optional[str] = Cookie(default=None, alias="hermes_session"),
) -> dict[str, str]:
    settings = get_settings()
    if hermes_session:
        get_store().delete_web_session(hermes_session)
    response.delete_cookie(settings.session_cookie, path="/")
    return {"status": "ok"}


@router.post("/bind-key")
def bind_key(
    body: BindKeyBody,
    response: Response,
    hermes_session: Optional[str] = Cookie(default=None, alias="hermes_session"),
) -> dict[str, Any]:
    if not hermes_session:
        raise HTTPException(status_code=401, detail="unauthorized")
    store = get_store()
    vault = get_vault()
    try:
        session = store.verify_web_session(hermes_session)
    except InvalidCredentialsError as exc:
        raise HTTPException(status_code=401, detail="unauthorized") from exc

    settings = get_settings()
    if not settings.new_api_base_url:
        raise HTTPException(status_code=503, detail="NEW_API_BASE_URL not configured")

    try:
        user = store.bind_upstream_key(
            session["user_id"],
            body.api_key.strip(),
            base_url=settings.new_api_base_url,
            encrypt_key_fn=vault.encrypt,
        )
    except UserStoreError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except KeyVaultError as exc:
        raise HTTPException(status_code=500, detail="key storage error") from exc

    key_enc = store.get_user_upstream_key_enc(user["user_id"]) or ""
    _issue_cookie(response, store, user["user_id"], key_enc)
    return {"user": user, "upstream_status": user["upstream_status"]}


@router.get("/me")
def me(
    hermes_session: Optional[str] = Cookie(default=None, alias="hermes_session"),
) -> dict[str, Any]:
    _store, user = _require_session_user(hermes_session)
    return user


@router.patch("/me")
def patch_me(
    body: ProfilePatchBody,
    hermes_session: Optional[str] = Cookie(default=None, alias="hermes_session"),
) -> dict[str, Any]:
    store, user = _require_session_user(hermes_session)
    try:
        return store.update_profile(
            user["user_id"],
            nickname=body.nickname,
            email=str(body.email) if body.email is not None else None,
            avatar_url=body.avatar_url,
            clear_avatar=body.clear_avatar,
        )
    except UserStoreError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/change-password")
def change_password(
    body: ChangePasswordBody,
    hermes_session: Optional[str] = Cookie(default=None, alias="hermes_session"),
) -> dict[str, str]:
    store, user = _require_session_user(hermes_session)
    try:
        store.change_password(
            user["user_id"],
            body.current_password,
            body.new_password,
        )
    except InvalidCredentialsError as exc:
        raise HTTPException(status_code=401, detail="invalid credentials") from exc
    except UserStoreError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "ok"}
