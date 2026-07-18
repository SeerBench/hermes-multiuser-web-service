"""Object store: local fallback + s3 key isolation."""

from __future__ import annotations

import os

import pytest

from gateway.web.sandbox import enter_user_context, ensure_workspace
from platform_api.services.object_store import (
    assert_s3_key_for_workspace,
    build_storage_key,
    delete_object,
    is_s3_storage_key,
    minio_configured,
    open_local_path,
    parse_s3_key,
    put_bytes,
)


def test_local_put_bytes_and_delete(platform_env, monkeypatch):
    monkeypatch.delenv("MINIO_ENDPOINT", raising=False)
    assert not minio_configured()
    user_id = "u_obj_local"
    ensure_workspace(user_id)
    with enter_user_context(user_id):
        key = put_bytes(
            workspace_id="ws1",
            file_id="f1",
            filename="hello.txt",
            data=b"hello-local",
        )
        assert not is_s3_storage_key(key)
        assert key.startswith("uploads/")
        with open_local_path(key) as path:
            assert path.read_bytes() == b"hello-local"
        assert delete_object(key) is True


def test_build_storage_key_s3_when_minio_env(monkeypatch):
    monkeypatch.setenv("MINIO_ENDPOINT", "http://127.0.0.1:9000")
    monkeypatch.setenv("MINIO_ACCESS_KEY", "minio")
    monkeypatch.setenv("MINIO_SECRET_KEY", "minio123")
    monkeypatch.setenv("MINIO_BUCKET", "hermes")
    key = build_storage_key(
        workspace_id="ws-abc", file_id="fid", filename="doc.pdf"
    )
    assert key.startswith("s3://hermes/ws-abc/uploads/")
    assert is_s3_storage_key(key)
    assert_s3_key_for_workspace(key, "ws-abc")
    with pytest.raises(PermissionError):
        assert_s3_key_for_workspace(key, "other-ws")


def test_delete_object_refuses_foreign_s3_key(monkeypatch):
    monkeypatch.setenv("MINIO_ENDPOINT", "http://127.0.0.1:9000")
    monkeypatch.setenv("MINIO_ACCESS_KEY", "minio")
    monkeypatch.setenv("MINIO_SECRET_KEY", "minio123")
    monkeypatch.setenv("MINIO_BUCKET", "hermes")
    foreign = "s3://hermes/other-ws/uploads/f_x.txt"
    assert delete_object(foreign, workspace_id="ws-mine") is False


def test_parse_s3_key_rejects_traversal():
    with pytest.raises(ValueError, match="escapes"):
        parse_s3_key("s3://hermes/ws/../other/uploads/x.txt")
    with pytest.raises(ValueError, match="invalid"):
        parse_s3_key("s3://bucketonly")
    with pytest.raises(ValueError, match="not an s3"):
        parse_s3_key("uploads/local.txt")

