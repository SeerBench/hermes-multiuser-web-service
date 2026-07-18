"""Add memory_items table for Memory Center."""

from alembic import op
import sqlalchemy as sa

revision = "002_memory_items"
down_revision = "001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "memory_items",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("tenant_id", sa.String(length=36), nullable=False),
        sa.Column("workspace_id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("category", sa.String(length=32), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="1.0"),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("importance", sa.Integer(), nullable=False, server_default="50"),
        sa.Column("source_ref", sa.String(length=512), nullable=True),
        sa.Column("raw_excerpt", sa.Text(), nullable=True),
        sa.Column("ai_summary", sa.Text(), nullable=True),
        sa.Column("metadata_json", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_memory_items_tenant_id", "memory_items", ["tenant_id"])
    op.create_index(
        "ix_memory_items_workspace_status", "memory_items", ["workspace_id", "status"]
    )
    op.create_index(
        "ix_memory_items_workspace_category",
        "memory_items",
        ["workspace_id", "category"],
    )
    op.create_index(
        "ix_memory_items_user_updated", "memory_items", ["user_id", "updated_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_memory_items_user_updated", table_name="memory_items")
    op.drop_index("ix_memory_items_workspace_category", table_name="memory_items")
    op.drop_index("ix_memory_items_workspace_status", table_name="memory_items")
    op.drop_index("ix_memory_items_tenant_id", table_name="memory_items")
    op.drop_table("memory_items")
