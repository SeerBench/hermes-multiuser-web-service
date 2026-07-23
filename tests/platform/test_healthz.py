"""Deep /api/v1/healthz: database + optional Redis / MinIO probes."""

from __future__ import annotations

from unittest.mock import MagicMock


def test_healthz_ok_local_defaults(client, platform_env, monkeypatch):
    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.delenv("MINIO_ENDPOINT", raising=False)

    resp = client.get("/api/v1/healthz")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "ok"
    assert body["service"] == "platform-api"
    assert body["checks"]["database"]["status"] == "ok"
    assert "latency_ms" in body["checks"]["database"]
    assert body["checks"]["redis"]["status"] == "skipped"
    assert body["checks"]["object_store"]["status"] == "local"


def test_healthz_redis_configured_but_ping_fails(client, platform_env, monkeypatch):
    monkeypatch.setenv("REDIS_URL", "redis://127.0.0.1:6399/0")
    monkeypatch.delenv("MINIO_ENDPOINT", raising=False)

    bad = MagicMock()
    bad.ping.side_effect = ConnectionError("redis down")
    monkeypatch.setattr(
        "platform_api.services.health_checks._redis_client",
        lambda: bad,
    )

    resp = client.get("/api/v1/healthz")
    assert resp.status_code == 503, resp.text
    body = resp.json()
    assert body["status"] == "degraded"
    assert body["checks"]["database"]["status"] == "ok"
    assert body["checks"]["redis"]["status"] == "error"
    assert body["checks"]["object_store"]["status"] == "local"


def test_healthz_minio_configured_but_head_fails(client, platform_env, monkeypatch):
    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.setenv("MINIO_ENDPOINT", "http://127.0.0.1:9000")
    monkeypatch.setenv("MINIO_ACCESS_KEY", "minio")
    monkeypatch.setenv("MINIO_SECRET_KEY", "minio123")
    monkeypatch.setenv("MINIO_BUCKET", "hermes")

    monkeypatch.setattr(
        "platform_api.services.health_checks._minio_head_bucket",
        lambda: (_ for _ in ()).throw(RuntimeError("minio unreachable")),
    )

    resp = client.get("/api/v1/healthz")
    assert resp.status_code == 503, resp.text
    body = resp.json()
    assert body["status"] == "degraded"
    assert body["checks"]["object_store"]["status"] == "error"
    assert body["checks"]["database"]["status"] == "ok"
    assert body["checks"]["redis"]["status"] == "skipped"


def test_healthz_database_ping_fails(client, platform_env, monkeypatch):
    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.delenv("MINIO_ENDPOINT", raising=False)

    from platform_api import deps

    store = deps.get_store()
    monkeypatch.setattr(
        store,
        "ping",
        MagicMock(side_effect=RuntimeError("db down")),
    )

    resp = client.get("/api/v1/healthz")
    assert resp.status_code == 503, resp.text
    body = resp.json()
    assert body["status"] == "degraded"
    assert body["checks"]["database"]["status"] == "error"
