"""Usage Center ledger: usage_records."""

from alembic import op
import sqlalchemy as sa

revision = "004_usage_records"
down_revision = "003_knowledge_center"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "usage_records",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("tenant_id", sa.String(length=36), nullable=False),
        sa.Column("workspace_id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("type", sa.String(length=32), nullable=False),
        sa.Column("model", sa.String(length=128), nullable=True),
        sa.Column("skill_name", sa.String(length=128), nullable=True),
        sa.Column("knowledge_id", sa.String(length=36), nullable=True),
        sa.Column("tool_name", sa.String(length=128), nullable=True),
        sa.Column("session_id", sa.String(length=128), nullable=True),
        sa.Column("input_tokens", sa.Integer(), nullable=False),
        sa.Column("output_tokens", sa.Integer(), nullable=False),
        sa.Column("total_tokens", sa.Integer(), nullable=False),
        sa.Column("cost", sa.Float(), nullable=False),
        sa.Column("metadata_json", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_usage_records_tenant_id", "usage_records", ["tenant_id"])
    op.create_index(
        "ix_usage_records_user_created", "usage_records", ["user_id", "created_at"]
    )
    op.create_index(
        "ix_usage_records_workspace_created",
        "usage_records",
        ["workspace_id", "created_at"],
    )
    op.create_index(
        "ix_usage_records_type_created", "usage_records", ["type", "created_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_usage_records_type_created", table_name="usage_records")
    op.drop_index("ix_usage_records_workspace_created", table_name="usage_records")
    op.drop_index("ix_usage_records_user_created", table_name="usage_records")
    op.drop_index("ix_usage_records_tenant_id", table_name="usage_records")
    op.drop_table("usage_records")
