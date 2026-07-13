"""Upstream new-api user provisioning (auto + manual fallback)."""

from __future__ import annotations

import logging
import os
import secrets
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional

import httpx

logger = logging.getLogger("hermes.web.provisioner")


@dataclass
class ProvisionResult:
    upstream_user_id: Optional[str]
    api_key: Optional[str]
    mode: str  # "auto" | "manual"


class UpstreamProvisioner(ABC):
    @abstractmethod
    def provision(self, email: str) -> ProvisionResult:
        ...


class ManualProvisioner(UpstreamProvisioner):
    """Register succeeds; user binds a key later via bind-key."""

    def provision(self, email: str) -> ProvisionResult:
        _ = email
        return ProvisionResult(upstream_user_id=None, api_key=None, mode="manual")


class AutoProvisioner(UpstreamProvisioner):
    """Call new-api Admin API to create a user and token.

    MVP: best-effort POST to configurable admin endpoints.  Falls back to
    manual mode when admin token or endpoints are missing.
    """

    def __init__(
        self,
        base_url: str,
        admin_token: str,
        *,
        create_user_path: str = "/api/user/",
        create_token_path: str = "/api/token/",
    ):
        self._base = base_url.rstrip("/")
        self._admin_token = admin_token
        self._create_user_path = create_user_path
        self._create_token_path = create_token_path

    def provision(self, email: str) -> ProvisionResult:
        if not self._base or not self._admin_token:
            logger.warning("AutoProvisioner missing base URL or admin token — manual fallback")
            return ProvisionResult(None, None, "manual")

        headers = {"Authorization": f"Bearer {self._admin_token}"}
        username = email.split("@", 1)[0] or f"user_{secrets.token_hex(4)}"
        password = secrets.token_urlsafe(24)

        try:
            with httpx.Client(timeout=30.0) as client:
                user_resp = client.post(
                    f"{self._base}{self._create_user_path}",
                    headers=headers,
                    json={
                        "username": username,
                        "password": password,
                        "display_name": email,
                        "email": email,
                    },
                )
                if user_resp.status_code >= 400:
                    logger.warning(
                        "AutoProvisioner create user failed: %s %s",
                        user_resp.status_code,
                        user_resp.text[:200],
                    )
                    return ProvisionResult(None, None, "manual")

                user_data = user_resp.json()
                upstream_user_id = str(
                    user_data.get("id") or user_data.get("data", {}).get("id") or username
                )

                token_resp = client.post(
                    f"{self._base}{self._create_token_path}",
                    headers=headers,
                    json={
                        "name": f"hermes-{upstream_user_id}",
                        "user_id": upstream_user_id,
                        "unlimited_quota": False,
                    },
                )
                if token_resp.status_code >= 400:
                    logger.warning(
                        "AutoProvisioner create token failed: %s",
                        token_resp.status_code,
                    )
                    return ProvisionResult(upstream_user_id, None, "manual")

                token_data = token_resp.json()
                api_key = (
                    token_data.get("key")
                    or token_data.get("data", {}).get("key")
                    or token_data.get("token")
                )
                if not api_key:
                    return ProvisionResult(upstream_user_id, None, "manual")

                return ProvisionResult(upstream_user_id, str(api_key), "auto")
        except httpx.HTTPError as exc:
            logger.warning("AutoProvisioner HTTP error: %s", exc)
            return ProvisionResult(None, None, "manual")


def get_provisioner() -> UpstreamProvisioner:
    mode = (os.environ.get("UPSTREAM_PROVISIONER") or "auto").strip().lower()
    if mode == "manual":
        return ManualProvisioner()

    base = os.environ.get("NEW_API_BASE_URL", "").strip()
    admin = os.environ.get("NEW_API_ADMIN_TOKEN", "").strip()
    if not base or not admin:
        return ManualProvisioner()
    return AutoProvisioner(base, admin)
