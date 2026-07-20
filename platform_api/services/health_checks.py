"""Deep readiness probes for Platform API /healthz."""

from __future__ import annotations

import time
from typing import Any

from platform_api.services import object_store as object_store_mod
from platform_api.services import queue as queue_mod


def _redis_client():
    """Indirection for tests (mock this instead of queue internals)."""
    return queue_mod._redis()


def _minio_head_bucket() -> None:
    """Indirection for tests — raises if MinIO/S3 bucket is unreachable."""
    cfg = object_store_mod._minio_settings()
    client = object_store_mod._boto_client()
    client.head_bucket(Bucket=cfg["bucket"])


def check_database(store: Any) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        store.ping()
        latency_ms = round((time.perf_counter() - started) * 1000, 2)
        return {"status": "ok", "latency_ms": latency_ms}
    except Exception as exc:
        latency_ms = round((time.perf_counter() - started) * 1000, 2)
        return {
            "status": "error",
            "latency_ms": latency_ms,
            "detail": str(exc)[:200],
        }


def check_redis() -> dict[str, Any]:
    if not queue_mod.redis_configured():
        return {"status": "skipped", "detail": "REDIS_URL unset"}
    started = time.perf_counter()
    try:
        client = _redis_client()
        client.ping()
        latency_ms = round((time.perf_counter() - started) * 1000, 2)
        return {"status": "ok", "latency_ms": latency_ms}
    except Exception as exc:
        latency_ms = round((time.perf_counter() - started) * 1000, 2)
        return {
            "status": "error",
            "latency_ms": latency_ms,
            "detail": str(exc)[:200],
        }


def check_object_store() -> dict[str, Any]:
    if not object_store_mod.minio_configured():
        return {"status": "local", "detail": "MINIO_ENDPOINT unset; using workspace uploads"}
    started = time.perf_counter()
    try:
        _minio_head_bucket()
        latency_ms = round((time.perf_counter() - started) * 1000, 2)
        return {"status": "ok", "latency_ms": latency_ms}
    except Exception as exc:
        latency_ms = round((time.perf_counter() - started) * 1000, 2)
        return {
            "status": "error",
            "latency_ms": latency_ms,
            "detail": str(exc)[:200],
        }


def run_health_checks(store: Any) -> tuple[int, dict[str, Any]]:
    """Return (http_status, body) for GET /api/v1/healthz."""
    checks = {
        "database": check_database(store),
        "redis": check_redis(),
        "object_store": check_object_store(),
    }
    healthy = (
        checks["database"]["status"] == "ok"
        and checks["redis"]["status"] in ("ok", "skipped")
        and checks["object_store"]["status"] in ("ok", "local")
    )
    body = {
        "status": "ok" if healthy else "degraded",
        "service": "platform-api",
        "checks": checks,
    }
    return (200 if healthy else 503, body)
