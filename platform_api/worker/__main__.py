"""Ingest worker: ``python -m platform_api.worker`` or ``hermes-platform-worker``."""

from __future__ import annotations

import logging
import os
import sys
import time
from typing import Any

logging.basicConfig(
    level=os.environ.get("HERMES_WORKER_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s [ingest-worker] %(message)s",
)
logger = logging.getLogger("hermes.platform.worker")


def handle_ingest_job(job: dict[str, Any]) -> str:
    """Process one queue payload. Returns ``ok``, ``skip``, ``retry``, or ``dlq``."""
    file_id = job.get("file_id")
    user_id = job.get("user_id")
    if not file_id or not user_id:
        logger.warning("malformed job: %s", job)
        return "skip"
    try:
        from platform_api.services.ingest import ingest_file_record

        ingest_file_record(str(file_id), str(user_id), raise_on_error=True)
        logger.info("ingest ok file=%s attempt=%s", file_id, job.get("attempt"))
        return "ok"
    except Exception as exc:
        from platform_api.services.queue import requeue_or_deadletter

        action = requeue_or_deadletter(job, error=str(exc))
        logger.warning(
            "ingest fail file=%s action=%s err=%s",
            file_id,
            action,
            exc,
        )
        return action


def main() -> None:
    from platform_api.services.queue import brpop_ingest, redis_configured

    if not redis_configured():
        logger.error("REDIS_URL is not set — worker has nothing to consume")
        sys.exit(1)

    logger.info("ingest worker started queue=hermes:ingest")
    while True:
        try:
            job = brpop_ingest(timeout=5)
        except Exception:
            logger.exception("brpop failed; sleeping")
            time.sleep(2)
            continue
        if not job:
            continue
        handle_ingest_job(job)


if __name__ == "__main__":
    main()
