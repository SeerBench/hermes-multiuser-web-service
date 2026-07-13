"""Initial platform schema (MVP — mirrors ORM models)."""

from alembic import op
import sqlalchemy as sa

revision = "001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # MVP: create_all equivalent — use autogenerate in production workflows.
    from gateway.web.platform.models import Base
    from sqlalchemy import create_engine
    import os

    bind = op.get_bind()
    Base.metadata.create_all(bind=bind)


def downgrade() -> None:
    from gateway.web.platform.models import Base

    bind = op.get_bind()
    Base.metadata.drop_all(bind=bind)
