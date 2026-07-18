"""Outbound mail for platform-api (password reset, etc.).

Production: SMTP via ``PLATFORM_SMTP_*``.
Local / unset SMTP: ``ConsoleMailer`` logs the message at WARNING so
operators can still complete the flow without a mail server.
"""

from __future__ import annotations

import logging
import smtplib
from email.message import EmailMessage
from functools import lru_cache
from typing import Protocol

from platform_api.config import Settings

logger = logging.getLogger("hermes.platform.mail")


class Mailer(Protocol):
    def send(self, *, to: str, subject: str, body: str) -> None: ...


class ConsoleMailer:
    """Dev / fallback: print reset content to logs (never use as sole prod path)."""

    def send(self, *, to: str, subject: str, body: str) -> None:
        logger.warning(
            "ConsoleMailer (SMTP not configured) to=%s subject=%s\n%s",
            to,
            subject,
            body,
        )


class SmtpMailer:
    def __init__(
        self,
        *,
        host: str,
        port: int,
        user: str,
        password: str,
        mail_from: str,
        use_tls: bool = True,
    ) -> None:
        self._host = host
        self._port = port
        self._user = user
        self._password = password
        self._mail_from = mail_from
        self._use_tls = use_tls

    def send(self, *, to: str, subject: str, body: str) -> None:
        msg = EmailMessage()
        msg["From"] = self._mail_from
        msg["To"] = to
        msg["Subject"] = subject
        msg.set_content(body)
        with smtplib.SMTP(self._host, self._port, timeout=30) as smtp:
            if self._use_tls:
                smtp.starttls()
            if self._user:
                smtp.login(self._user, self._password)
            smtp.send_message(msg)


def build_mailer(settings: Settings) -> Mailer:
    host = (settings.smtp_host or "").strip()
    if not host:
        return ConsoleMailer()
    mail_from = (settings.mail_from or settings.smtp_user or "noreply@localhost").strip()
    return SmtpMailer(
        host=host,
        port=settings.smtp_port,
        user=settings.smtp_user,
        password=settings.smtp_password,
        mail_from=mail_from,
        use_tls=settings.smtp_use_tls,
    )


@lru_cache
def get_mailer() -> Mailer:
    return build_mailer(Settings.from_env())


def reset_mailer_for_tests() -> None:
    get_mailer.cache_clear()
