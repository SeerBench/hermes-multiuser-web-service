"""PostgreSQL/SQLite-backed user + session store for the SaaS control plane.

Implements the same session/flag surface as :class:`gateway.web.users.UserStore`
so ``web_chat`` auth middleware can swap backends via
:func:`gateway.web.user_store_factory.create_user_store`.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from gateway.web.platform.database import create_schema, get_session_factory, session_scope
from gateway.web.platform.models import (
    AuditLog,
    ConversationFlag,
    DocumentChunk,
    FileRecord,
    PasswordResetToken,
    PlatformSession,
    SkillEntitlement,
    Tenant,
    User,
    Workspace,
)
from gateway.web.platform.passwords import hash_password, verify_password
from gateway.web.platform.provisioner import ProvisionResult, UpstreamProvisioner, get_provisioner
from gateway.web.sandbox import ensure_workspace, enter_user_context
from gateway.web.users import InvalidCredentialsError, UserStoreError
from gateway.web.upstream_validator import validate_key_against_upstream

logger = logging.getLogger("hermes.web.platform.store")

_WEB_SESSION_PREFIX = "hermes_ws_"
_DEFAULT_WEB_SESSION_TTL_SECONDS = 7 * 24 * 3600


def _sha256(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _new_web_session_token() -> str:
    return _WEB_SESSION_PREFIX + secrets.token_hex(32)


def _dt_to_epoch(dt: datetime) -> float:
    return dt.timestamp()


def _ensure_utc(dt: datetime) -> datetime:
    """Normalize DB datetimes — SQLite returns naive UTC values."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


class PlatformStore:
    """Thread-safe enough for low-traffic gateway (one session factory per engine)."""

    def __init__(self, engine: Engine):
        self._engine = engine
        create_schema(engine)
        self._session_factory = get_session_factory(engine)

    def close(self) -> None:
        self._engine.dispose()

    def ping(self) -> None:
        """Lightweight connectivity check for /healthz (raises on failure)."""
        with self._session_factory() as db:
            db.execute(text("SELECT 1"))

    # ── UserStore-compatible surface ───────────────────────────────────

    def upsert_user(self, user_id: str) -> None:
        """Legacy key-login path: ensure user + Default workspace exist.

        Gateway ``POST /api/auth/login`` calls this for API-key users.  Without
        a Workspace row, platform-mode SPA pages (Files / Memory / Skills)
        have nowhere to attach and show「未登录或无工作区」.
        """
        now = datetime.now(timezone.utc)
        with session_scope(self._engine) as db:
            user = db.get(User, user_id)
            if user is None:
                tenant = Tenant(name=f"legacy-{user_id[:8]}", plan="free")
                db.add(tenant)
                db.flush()
                user = User(
                    id=user_id,
                    tenant_id=tenant.id,
                    email=f"{user_id}@legacy.local",
                    password_hash="!",
                    role="user",
                    status="active",
                    upstream_status="ready",
                    disabled=False,
                    created_at=now,
                    last_seen_at=now,
                )
                db.add(user)
                db.flush()
                db.add(
                    Workspace(
                        tenant_id=tenant.id,
                        owner_id=user.id,
                        name="Default",
                    )
                )
                db.flush()
                ensure_workspace(user.id)
            else:
                user.last_seen_at = now
                # Backfill workspace for key-login users created before
                # workspace was part of upsert_user.
                existing_ws = db.execute(
                    select(Workspace).where(Workspace.owner_id == user.id)
                ).scalars().first()
                if existing_ws is None:
                    db.add(
                        Workspace(
                            tenant_id=user.tenant_id,
                            owner_id=user.id,
                            name="Default",
                        )
                    )
                    db.flush()
                    ensure_workspace(user.id)

    def get_user(self, user_id: str) -> Optional[Dict[str, Any]]:
        with self._session_factory() as db:
            user = db.get(User, user_id)
            if not user:
                return None
            return self._user_to_dict(user)

    def set_disabled(self, user_id: str, disabled: bool) -> None:
        with session_scope(self._engine) as db:
            db.execute(
                update(User)
                .where(User.id == user_id)
                .values(disabled=disabled, status="disabled" if disabled else "active")
            )

    def create_web_session(
        self,
        user_id: str,
        encrypted_api_key: str,
        ttl_seconds: int = _DEFAULT_WEB_SESSION_TTL_SECONDS,
    ) -> str:
        """Create a web session cookie token and sync the upstream key to the user.

        Legacy ``POST /api/auth/login`` only used to persist the encrypted key
        on ``PlatformSession``.  Platform endpoints such as
        ``GET /workspaces/{id}/models`` read ``User.upstream_api_key_enc``, so
        API-key logins produced an empty model picker (403 upstream key not
        bound).  Mirror bind-key: keep both session + user rows in sync.
        """
        if not self.get_user(user_id):
            raise UserStoreError(f"unknown user_id: {user_id}")
        plaintext = _new_web_session_token()
        expires = datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)
        with session_scope(self._engine) as db:
            db.add(
                PlatformSession(
                    token_hash=_sha256(plaintext),
                    user_id=user_id,
                    api_key_enc=encrypted_api_key or "",
                    expires_at=expires,
                )
            )
            # Sync encrypted upstream key onto the user row so control-plane
            # APIs (models, etc.) work after API-key login without a separate
            # bind-key step.
            if encrypted_api_key:
                user = db.get(User, user_id)
                if user is not None:
                    user.upstream_api_key_enc = encrypted_api_key
                    user.upstream_status = "ready"
                    user.last_seen_at = datetime.now(timezone.utc)
        return plaintext

    def verify_web_session(self, plaintext: str) -> Dict[str, Any]:
        if not plaintext or not plaintext.startswith(_WEB_SESSION_PREFIX):
            raise InvalidCredentialsError("bad session")
        now = datetime.now(timezone.utc)
        with self._session_factory() as db:
            row = db.execute(
                select(PlatformSession, User)
                .join(User, User.id == PlatformSession.user_id)
                .where(PlatformSession.token_hash == _sha256(plaintext))
            ).first()
            if not row:
                raise InvalidCredentialsError("bad session")
            sess, user = row
            if (
                _ensure_utc(sess.expires_at) < now
                or user.disabled
                or user.status == "disabled"
            ):
                raise InvalidCredentialsError("bad session")
            return {"user_id": user.id, "api_key_enc": sess.api_key_enc or ""}

    def delete_web_session(self, plaintext: str) -> None:
        if not plaintext:
            return
        with session_scope(self._engine) as db:
            db.execute(
                delete(PlatformSession).where(
                    PlatformSession.token_hash == _sha256(plaintext)
                )
            )

    def purge_expired_web_sessions(self) -> int:
        now = datetime.now(timezone.utc)
        with session_scope(self._engine) as db:
            rows = db.execute(select(PlatformSession)).scalars().all()
            removed = 0
            for sess in rows:
                if _ensure_utc(sess.expires_at) < now:
                    db.delete(sess)
                    removed += 1
            return removed

    def set_conversation_flag(
        self,
        user_id: str,
        session_id: str,
        *,
        pinned: Optional[bool] = None,
        archived: Optional[bool] = None,
    ) -> None:
        if not user_id or not session_id:
            raise UserStoreError("user_id and session_id are required")
        if pinned is None and archived is None:
            return
        now = datetime.now(timezone.utc)
        with session_scope(self._engine) as db:
            existing = db.execute(
                select(ConversationFlag).where(
                    ConversationFlag.user_id == user_id,
                    ConversationFlag.session_id == session_id,
                )
            ).scalar_one_or_none()
            if existing is None:
                db.add(
                    ConversationFlag(
                        user_id=user_id,
                        session_id=session_id,
                        pinned=bool(pinned) if pinned is not None else False,
                        archived=bool(archived) if archived is not None else False,
                        updated_at=now,
                    )
                )
            else:
                if pinned is not None:
                    existing.pinned = pinned
                if archived is not None:
                    existing.archived = archived
                existing.updated_at = now

    def get_conversation_flags(self, user_id: str) -> Dict[str, Dict[str, bool]]:
        if not user_id:
            return {}
        with self._session_factory() as db:
            rows = db.execute(
                select(ConversationFlag).where(ConversationFlag.user_id == user_id)
            ).scalars()
            return {
                r.session_id: {"pinned": r.pinned, "archived": r.archived}
                for r in rows
            }

    def clear_conversation_flags(self, user_id: str, session_id: str) -> None:
        if not user_id or not session_id:
            return
        with session_scope(self._engine) as db:
            db.execute(
                delete(ConversationFlag).where(
                    ConversationFlag.user_id == user_id,
                    ConversationFlag.session_id == session_id,
                )
            )

    # ── Platform SaaS API ──────────────────────────────────────────────

    def register_user(
        self,
        email: str,
        password: str,
        *,
        provisioner: Optional[UpstreamProvisioner] = None,
        encrypt_key_fn=None,
    ) -> Dict[str, Any]:
        email_norm = email.strip().lower()
        if not email_norm or not password:
            raise UserStoreError("email and password are required")

        prov = provisioner or get_provisioner()
        result: ProvisionResult = prov.provision(email_norm)

        now = datetime.now(timezone.utc)
        with session_scope(self._engine) as db:
            existing = db.execute(
                select(User).where(User.email == email_norm)
            ).scalar_one_or_none()
            if existing:
                raise UserStoreError("email already registered")

            tenant = Tenant(name=email_norm.split("@", 1)[0], plan="free")
            db.add(tenant)
            db.flush()

            upstream_status = "ready" if result.api_key else "pending_bind"
            key_enc = ""
            if result.api_key and encrypt_key_fn:
                key_enc = encrypt_key_fn(result.api_key)

            user = User(
                tenant_id=tenant.id,
                email=email_norm,
                password_hash=hash_password(password),
                role="user",
                status="active",
                upstream_user_id=result.upstream_user_id,
                upstream_api_key_enc=key_enc or None,
                upstream_status=upstream_status,
                created_at=now,
                last_seen_at=now,
            )
            db.add(user)
            db.flush()

            workspace = Workspace(
                tenant_id=tenant.id,
                owner_id=user.id,
                name="Default",
            )
            db.add(workspace)
            db.flush()

            ensure_workspace(user.id)

            return {
                "user": self._user_to_dict(user),
                "workspace": {
                    "id": workspace.id,
                    "tenant_id": workspace.tenant_id,
                    "name": workspace.name,
                },
                "provision_mode": result.mode,
            }

    def authenticate_user(self, email: str, password: str) -> Dict[str, Any]:
        email_norm = email.strip().lower()
        with session_scope(self._engine) as db:
            user = db.execute(
                select(User).where(User.email == email_norm)
            ).scalar_one_or_none()
            if not user or user.disabled or user.status == "disabled":
                raise InvalidCredentialsError("invalid credentials")
            if not verify_password(user.password_hash, password):
                raise InvalidCredentialsError("invalid credentials")
            user.last_seen_at = datetime.now(timezone.utc)
            workspace = db.execute(
                select(Workspace).where(Workspace.owner_id == user.id)
            ).scalars().first()
            return {
                "user": self._user_to_dict(user),
                "workspace": {
                    "id": workspace.id,
                    "tenant_id": workspace.tenant_id,
                    "name": workspace.name,
                }
                if workspace
                else None,
            }

    def bind_upstream_key(
        self,
        user_id: str,
        api_key: str,
        *,
        base_url: str,
        encrypt_key_fn,
    ) -> Dict[str, Any]:
        from gateway.web.upstream_validator import validate_key_against_upstream_sync

        validation = validate_key_against_upstream_sync(api_key, base_url)
        if not validation.valid:
            raise UserStoreError(validation.error_msg or "invalid key")

        key_enc = encrypt_key_fn(api_key)
        with session_scope(self._engine) as db:
            user = db.get(User, user_id)
            if not user:
                raise UserStoreError("unknown user")
            user.upstream_api_key_enc = key_enc
            user.upstream_status = "ready"
            user.last_seen_at = datetime.now(timezone.utc)
            return self._user_to_dict(user)

    def update_profile(
        self,
        user_id: str,
        *,
        nickname: Optional[str] = None,
        email: Optional[str] = None,
        avatar_url: Optional[str] = None,
        clear_avatar: bool = False,
    ) -> Dict[str, Any]:
        """Update account profile fields. ``None`` means leave unchanged."""
        with session_scope(self._engine) as db:
            user = db.get(User, user_id)
            if not user or user.disabled:
                raise UserStoreError("unknown user")

            if nickname is not None:
                nick = nickname.strip()
                user.nickname = nick[:64] if nick else None

            if email is not None:
                next_email = email.strip().lower()
                if not next_email:
                    raise UserStoreError("email required")
                if next_email != user.email:
                    clash = db.execute(
                        select(User).where(User.email == next_email)
                    ).scalars().first()
                    if clash and clash.id != user_id:
                        raise UserStoreError("email already registered")
                    user.email = next_email

            if clear_avatar:
                user.avatar_url = None
            elif avatar_url is not None:
                url = avatar_url.strip()
                if len(url) > 350_000:
                    raise UserStoreError("avatar too large")
                user.avatar_url = url or None

            user.last_seen_at = datetime.now(timezone.utc)
            return self._user_to_dict(user)

    def change_password(
        self,
        user_id: str,
        current_password: str,
        new_password: str,
    ) -> None:
        if len(new_password) < 8:
            raise UserStoreError("password too short")
        with session_scope(self._engine) as db:
            user = db.get(User, user_id)
            if not user or user.disabled:
                raise InvalidCredentialsError("invalid credentials")
            if not verify_password(user.password_hash, current_password):
                raise InvalidCredentialsError("invalid credentials")
            user.password_hash = hash_password(new_password)
            user.last_seen_at = datetime.now(timezone.utc)

    def request_password_reset(
        self,
        email: str,
        *,
        ttl_seconds: int = 3600,
    ) -> Optional[str]:
        """Create a single-use reset token if the account exists and is active.

        Returns plaintext token for the mailer, or ``None`` when no mail
        should be sent (unknown / disabled). Prior unused tokens for the
        user are invalidated.
        """
        email_norm = email.strip().lower()
        ttl = max(60, int(ttl_seconds))
        now = datetime.now(timezone.utc)
        with session_scope(self._engine) as db:
            user = db.execute(
                select(User).where(User.email == email_norm)
            ).scalar_one_or_none()
            if not user or user.disabled or user.status == "disabled":
                return None
            db.execute(
                delete(PasswordResetToken).where(
                    PasswordResetToken.user_id == user.id,
                    PasswordResetToken.used_at.is_(None),
                )
            )
            plaintext = secrets.token_urlsafe(32)
            db.add(
                PasswordResetToken(
                    token_hash=_sha256(plaintext),
                    user_id=user.id,
                    expires_at=now + timedelta(seconds=ttl),
                    created_at=now,
                )
            )
            return plaintext

    def reset_password_with_token(self, token: str, new_password: str) -> None:
        """Consume a reset token, set the new password, revoke all sessions."""
        if len(new_password) < 8:
            raise UserStoreError("password too short")
        token = (token or "").strip()
        if not token:
            raise InvalidCredentialsError("invalid or expired token")
        now = datetime.now(timezone.utc)
        with session_scope(self._engine) as db:
            row = db.execute(
                select(PasswordResetToken).where(
                    PasswordResetToken.token_hash == _sha256(token)
                )
            ).scalar_one_or_none()
            if not row or row.used_at is not None:
                raise InvalidCredentialsError("invalid or expired token")
            expires = _ensure_utc(row.expires_at)
            if expires <= now:
                raise InvalidCredentialsError("invalid or expired token")
            user = db.get(User, row.user_id)
            if not user or user.disabled or user.status == "disabled":
                raise InvalidCredentialsError("invalid or expired token")
            user.password_hash = hash_password(new_password)
            user.last_seen_at = now
            row.used_at = now
            db.execute(
                delete(PlatformSession).where(PlatformSession.user_id == user.id)
            )

    def get_user_upstream_key_enc(self, user_id: str) -> Optional[str]:
        with self._session_factory() as db:
            user = db.get(User, user_id)
            return user.upstream_api_key_enc if user else None

    def get_default_workspace(self, user_id: str) -> Optional[Dict[str, Any]]:
        """Return the user's primary workspace (MVP: first owned workspace)."""
        with self._session_factory() as db:
            ws = db.execute(
                select(Workspace).where(Workspace.owner_id == user_id)
            ).scalars().first()
            if not ws:
                return None
            return {
                "id": ws.id,
                "tenant_id": ws.tenant_id,
                "name": ws.name,
            }

    def ensure_default_workspace(self, user_id: str) -> Optional[Dict[str, Any]]:
        """Return Default workspace, creating it when missing (API-key users)."""
        existing = self.get_default_workspace(user_id)
        if existing:
            return existing
        with session_scope(self._engine) as db:
            user = db.get(User, user_id)
            if not user:
                return None
            ws = db.execute(
                select(Workspace).where(Workspace.owner_id == user.id)
            ).scalars().first()
            if ws is None:
                db.add(
                    Workspace(
                        tenant_id=user.tenant_id,
                        owner_id=user.id,
                        name="Default",
                    )
                )
                db.flush()
                ensure_workspace(user.id)
        return self.get_default_workspace(user_id)

    def list_enabled_skill_names(self, user_id: str) -> List[str]:
        """Skill names enabled for chat hints (entitlements + defaults)."""
        with self._session_factory() as db:
            ws = db.execute(
                select(Workspace).where(Workspace.owner_id == user_id)
            ).scalars().first()
            if not ws:
                return []
            disabled = {
                r.skill_name
                for r in db.execute(
                    select(SkillEntitlement).where(
                        SkillEntitlement.workspace_id == ws.id,
                        SkillEntitlement.enabled.is_(False),
                    )
                ).scalars()
            }
        # Global skills minus explicit disables; user-private skills included.
        # Apple / macOS-only skills stay hidden on the web surface.
        from gateway.web.skill_filters import is_web_excluded_skill
        from hermes_constants import get_hermes_home

        names: set[str] = set()
        for root in (get_hermes_home() / "skills",):
            if root.is_dir():
                for skill_md in root.rglob("SKILL.md"):
                    name = skill_md.parent.name
                    category = skill_md.parent.parent.name
                    if name in disabled:
                        continue
                    if is_web_excluded_skill(category=category, name=name):
                        continue
                    names.add(name)
        with enter_user_context(user_id):
            from gateway.web.sandbox import get_user_workspace

            user_skills = get_user_workspace() / "skills"
            if user_skills.is_dir():
                for skill_md in user_skills.rglob("SKILL.md"):
                    name = skill_md.parent.name
                    category = skill_md.parent.parent.name
                    if name in disabled:
                        continue
                    if is_web_excluded_skill(category=category, name=name):
                        continue
                    names.add(name)
        return sorted(names)

    def list_users_admin(
        self,
        *,
        limit: int = 100,
        offset: int = 0,
        email: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Paginated admin user list; optional case-insensitive email substring."""
        limit = max(1, min(int(limit), 200))
        offset = max(0, int(offset))
        with self._session_factory() as db:
            stmt = select(User)
            count_stmt = select(func.count()).select_from(User)
            needle = (email or "").strip()
            if needle:
                pattern = f"%{needle}%"
                stmt = stmt.where(User.email.ilike(pattern))
                count_stmt = count_stmt.where(User.email.ilike(pattern))
            total = int(db.execute(count_stmt).scalar_one())
            rows = db.execute(
                stmt.order_by(User.created_at.desc()).limit(limit).offset(offset)
            ).scalars()
            return {
                "users": [self._user_to_dict(u) for u in rows],
                "total": total,
                "limit": limit,
                "offset": offset,
            }

    def list_audit_logs(
        self,
        *,
        limit: int = 50,
        offset: int = 0,
    ) -> Dict[str, Any]:
        """Newest-first audit log page for the admin console."""
        limit = max(1, min(int(limit), 200))
        offset = max(0, int(offset))
        with self._session_factory() as db:
            total = int(db.execute(select(func.count()).select_from(AuditLog)).scalar_one())
            rows = db.execute(
                select(AuditLog)
                .order_by(AuditLog.created_at.desc())
                .limit(limit)
                .offset(offset)
            ).scalars()
            items = [
                {
                    "id": row.id,
                    "actor_id": row.actor_id,
                    "action": row.action,
                    "target_type": row.target_type,
                    "target_id": row.target_id,
                    "metadata": row.metadata_json or {},
                    "created_at": _dt_to_epoch(row.created_at),
                }
                for row in rows
            ]
            return {
                "items": items,
                "total": total,
                "limit": limit,
                "offset": offset,
            }

    def admin_stats(self) -> Dict[str, Any]:
        with self._session_factory() as db:
            user_count = len(db.execute(select(User.id)).all())
            file_count = len(db.execute(select(FileRecord.id)).all())
            chunk_count = len(db.execute(select(DocumentChunk.id)).all())
            return {
                "users": user_count,
                "files": file_count,
                "chunks": chunk_count,
            }

    def audit(self, actor_id: Optional[str], action: str, **meta: Any) -> None:
        with session_scope(self._engine) as db:
            db.add(
                AuditLog(
                    actor_id=actor_id,
                    action=action,
                    target_type=meta.get("target_type"),
                    target_id=meta.get("target_id"),
                    metadata_json={k: v for k, v in meta.items() if k not in ("target_type", "target_id")},
                )
            )

    @staticmethod
    def _user_to_dict(user: User) -> Dict[str, Any]:
        return {
            "user_id": user.id,
            "id": user.id,
            "email": user.email,
            "nickname": getattr(user, "nickname", None),
            "avatar_url": getattr(user, "avatar_url", None),
            "role": user.role,
            "status": user.status,
            "disabled": user.disabled,
            "tenant_id": user.tenant_id,
            "upstream_status": user.upstream_status,
            "created_at": _dt_to_epoch(user.created_at),
            "last_seen_at": _dt_to_epoch(user.last_seen_at),
        }


def create_platform_store(database_url: str) -> PlatformStore:
    from gateway.web.platform.database import init_engine

    engine = init_engine(database_url)
    return PlatformStore(engine)
