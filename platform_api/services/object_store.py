"""Object storage abstraction: local workspace (default) or MinIO/S3.

When ``MINIO_ENDPOINT`` is set, platform uploads go to the configured bucket.
Otherwise behaviour matches the historical workspace-relative ``uploads/`` path.
"""

from __future__ import annotations

import logging
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional

logger = logging.getLogger("hermes.platform.object_store")

_S3_PREFIX = "s3://"


def minio_configured() -> bool:
    return bool((os.environ.get("MINIO_ENDPOINT") or "").strip())


def _minio_settings() -> dict[str, str]:
    endpoint = (os.environ.get("MINIO_ENDPOINT") or "").strip().rstrip("/")
    access = (os.environ.get("MINIO_ACCESS_KEY") or "").strip()
    secret = (os.environ.get("MINIO_SECRET_KEY") or "").strip()
    bucket = (os.environ.get("MINIO_BUCKET") or "hermes").strip() or "hermes"
    secure = (os.environ.get("MINIO_SECURE") or "false").strip().lower() in (
        "1",
        "true",
        "yes",
    )
    if not endpoint or not access or not secret:
        raise RuntimeError("MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY required")
    return {
        "endpoint": endpoint,
        "access_key": access,
        "secret_key": secret,
        "bucket": bucket,
        "secure": "1" if secure else "0",
    }


def is_s3_storage_key(storage_key: str) -> bool:
    return (storage_key or "").startswith(_S3_PREFIX)


def build_storage_key(
    *,
    workspace_id: str,
    file_id: str,
    filename: str,
) -> str:
    """Return the key to store on FileRecord for a new upload."""
    safe = Path(filename).name.replace("..", "_")
    rel = f"{workspace_id}/uploads/{file_id}_{safe}"
    if minio_configured():
        bucket = (os.environ.get("MINIO_BUCKET") or "hermes").strip() or "hermes"
        return f"{_S3_PREFIX}{bucket}/{rel}"
    return f"uploads/{file_id}_{safe}"


def parse_s3_key(storage_key: str) -> tuple[str, str]:
    """Return (bucket, object_key) for an ``s3://bucket/key`` storage_key."""
    if not is_s3_storage_key(storage_key):
        raise ValueError(f"not an s3 key: {storage_key!r}")
    rest = storage_key[len(_S3_PREFIX) :]
    bucket, _, key = rest.partition("/")
    if not bucket or not key:
        raise ValueError(f"invalid s3 key: {storage_key!r}")
    if ".." in key.split("/"):
        raise ValueError(f"s3 key escapes: {storage_key!r}")
    return bucket, key


def assert_s3_key_for_workspace(storage_key: str, workspace_id: str) -> None:
    """Reject s3 keys that do not start with ``{workspace_id}/``."""
    _bucket, key = parse_s3_key(storage_key)
    prefix = f"{workspace_id}/"
    if not key.startswith(prefix):
        raise PermissionError(
            f"s3 key not under workspace {workspace_id}: {storage_key!r}"
        )


def _boto_client():
    try:
        import boto3
        from botocore.client import Config
    except ImportError as exc:
        raise RuntimeError(
            "boto3 required for MinIO; install platform extra with boto3"
        ) from exc
    cfg = _minio_settings()
    return boto3.client(
        "s3",
        endpoint_url=cfg["endpoint"],
        aws_access_key_id=cfg["access_key"],
        aws_secret_access_key=cfg["secret_key"],
        config=Config(signature_version="s3v4"),
        use_ssl=cfg["secure"] == "1",
    )


def ensure_bucket() -> None:
    """Create the configured bucket if missing (best-effort)."""
    if not minio_configured():
        return
    cfg = _minio_settings()
    client = _boto_client()
    bucket = cfg["bucket"]
    try:
        client.head_bucket(Bucket=bucket)
    except Exception:
        try:
            client.create_bucket(Bucket=bucket)
            logger.info("created MinIO bucket %s", bucket)
        except Exception:
            logger.exception("ensure_bucket failed for %s", bucket)


def put_bytes(
    *,
    workspace_id: str,
    file_id: str,
    filename: str,
    data: bytes,
    user_id: Optional[str] = None,
) -> str:
    """Persist bytes; return storage_key. Requires user context for local backend."""
    _ = user_id
    key = build_storage_key(
        workspace_id=workspace_id, file_id=file_id, filename=filename
    )
    if is_s3_storage_key(key):
        ensure_bucket()
        bucket, obj = parse_s3_key(key)
        assert_s3_key_for_workspace(key, workspace_id)
        _boto_client().put_object(Bucket=bucket, Key=obj, Body=data)
        return key

    from gateway.web.sandbox import confine_path, get_user_workspace

    ws = get_user_workspace()
    if ws is None:
        raise RuntimeError("local put_bytes requires enter_user_context")
    path = confine_path(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return key


def delete_object(storage_key: str, *, workspace_id: Optional[str] = None) -> bool:
    """Delete local or s3 object. Returns True if something was removed."""
    if is_s3_storage_key(storage_key):
        try:
            if workspace_id:
                assert_s3_key_for_workspace(storage_key, workspace_id)
            bucket, obj = parse_s3_key(storage_key)
            _boto_client().delete_object(Bucket=bucket, Key=obj)
            return True
        except PermissionError:
            logger.warning("refusing to delete foreign s3 key=%r", storage_key)
            return False
        except Exception:
            logger.exception("s3 delete failed key=%s", storage_key)
            return False

    from gateway.web.sandbox import unlink_storage_key

    return unlink_storage_key(storage_key)


@contextmanager
def open_local_path(
    storage_key: str,
    *,
    workspace_id: Optional[str] = None,
) -> Iterator[Path]:
    """Yield a filesystem path for reading (temp file when object is remote)."""
    if is_s3_storage_key(storage_key):
        if workspace_id:
            assert_s3_key_for_workspace(storage_key, workspace_id)
        bucket, obj = parse_s3_key(storage_key)
        suffix = Path(obj).suffix or ".bin"
        fd, name = tempfile.mkstemp(prefix="hermes-obj-", suffix=suffix)
        os.close(fd)
        path = Path(name)
        try:
            _boto_client().download_file(bucket, obj, str(path))
            yield path
        finally:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        return

    from gateway.web.sandbox import confine_path

    yield confine_path(storage_key)
