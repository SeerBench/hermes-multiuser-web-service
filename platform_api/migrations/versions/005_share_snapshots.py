"""Immutable share snapshots for public read-only links."""

revision = "005_share_snapshots"
down_revision = "004_usage_records"
branch_labels = None
depends_on = None

from alembic import op
import sqlalchemy as sa


def upgrade() -> None:
    op.create_table(
        "share_snapshots",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("token", sa.String(length=64), nullable=False),
        sa.Column("owner_user_id", sa.String(length=36), nullable=False),
        sa.Column("tenant_id", sa.String(length=36), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("title", sa.String(length=512), nullable=True),
        sa.Column("payload_json", sa.JSON(), nullable=False),
        sa.Column("source_session_id", sa.String(length=128), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("token", name="uq_share_snapshots_token"),
    )
    op.create_index("ix_share_snapshots_tenant_id", "share_snapshots", ["tenant_id"])
    op.create_index(
        "ix_share_snapshots_owner_created",
        "share_snapshots",
        ["owner_user_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_share_snapshots_owner_created", table_name="share_snapshots")
    op.drop_index("ix_share_snapshots_tenant_id", table_name="share_snapshots")
    op.drop_table("share_snapshots")
