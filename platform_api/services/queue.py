"""Ingest job queue: Redis list when REDIS_URL set, else sync fallback."""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Optional

logger = logging.getLogger("hermes.platform.queue")

INGEST_QUEUE = "hermes:ingest"
INGEST_DLQ = "hermes:ingest:dlq"
MAX_ATTEMPTS = 3


def redis_configured() -> bool:
    return bool((os.environ.get("REDIS_URL") or "").strip())


def _redis():
    import redis

    url = (os.environ.get("REDIS_URL") or "").strip()
    return redis.Redis.from_url(url, decode_responses=True)


def enqueue_ingest(
    *,
    file_id: str,
    user_id: str,
    workspace_id: str,
    attempt: int = 0,
) -> dict[str, Any]:
    """Enqueue an ingest job, or run synchronously when Redis is unavailable."""
    payload = {
        "file_id": file_id,
        "user_id": user_id,
        "workspace_id": workspace_id,
        "attempt": int(attempt),
        "enqueued_at": time.time(),
    }
    if not redis_configured():
        from platform_api.services.ingest import ingest_file_record

        logger.debug("REDIS_URL unset — sync ingest file=%s", file_id)
        ingest_file_record(file_id, user_id)
        return {"mode": "sync", **payload}

    client = _redis()
    client.rpush(INGEST_QUEUE, json.dumps(payload))
    return {"mode": "async", **payload}


def brpop_ingest(timeout: int = 5) -> Optional[dict[str, Any]]:
    """Blocking pop from the ingest queue. Returns None on timeout."""
    if not redis_configured():
        return None
    client = _redis()
    item = client.brpop(INGEST_QUEUE, timeout=timeout)
    if not item:
        return None
    _queue, raw = item
    return json.loads(raw)


def requeue_or_deadletter(job: dict[str, Any], *, error: str) -> str:
    """Retry with backoff metadata, or push to DLQ when attempts exhausted."""
    attempt = int(job.get("attempt") or 0) + 1
    job = {**job, "attempt": attempt, "last_error": error[:500]}
    if not redis_configured():
        return "sync"
    client = _redis()
    if attempt >= MAX_ATTEMPTS:
        client.rpush(INGEST_DLQ, json.dumps(job))
        logger.warning(
            "ingest DLQ file=%s attempts=%s err=%s",
            job.get("file_id"),
            attempt,
            error[:200],
        )
        return "dlq"
    # Simple delay before requeue (worker sleeps; list has no delayed delivery).
    delay = min(2 ** attempt, 30)
    time.sleep(delay)
    client.rpush(INGEST_QUEUE, json.dumps(job))
    return "retry"


def dlq_length() -> int:
    if not redis_configured():
        return 0
    return int(_redis().llen(INGEST_DLQ) or 0)
