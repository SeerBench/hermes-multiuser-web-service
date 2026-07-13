"""SQLAlchemy engine and session factory for the platform control plane."""

from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Generator, Optional

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from gateway.web.platform.models import Base

_engine: Optional[Engine] = None
_SessionLocal: Optional[sessionmaker] = None


def get_database_url() -> Optional[str]:
    return os.environ.get("PLATFORM_DATABASE_URL") or None


def _enable_sqlite_fk(dbapi_conn, _connection_record) -> None:
    dbapi_conn.execute("PRAGMA foreign_keys=ON")


def init_engine(database_url: str) -> Engine:
    """Create (or return cached) engine.  Idempotent per process."""
    global _engine, _SessionLocal
    if _engine is not None and str(_engine.url) == database_url:
        return _engine

    connect_args = {}
    if database_url.startswith("sqlite"):
        connect_args["check_same_thread"] = False

    _engine = create_engine(database_url, future=True, connect_args=connect_args)
    if database_url.startswith("sqlite"):
        event.listen(_engine, "connect", _enable_sqlite_fk)

    _SessionLocal = sessionmaker(bind=_engine, autoflush=False, autocommit=False)
    return _engine


def create_schema(engine: Engine) -> None:
    """Create all tables (MVP — Alembic migrations live under platform-api/)."""
    Base.metadata.create_all(bind=engine)


@contextmanager
def session_scope(engine: Engine) -> Generator[Session, None, None]:
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    session = factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_session_factory(engine: Engine) -> sessionmaker:
    global _SessionLocal
    if _SessionLocal is None or _SessionLocal.kw["bind"] is not engine:
        _SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    return _SessionLocal
