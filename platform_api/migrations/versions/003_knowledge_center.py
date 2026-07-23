"""Knowledge Center tables: knowledge_bases, knowledge_files, knowledge_chunks."""

from alembic import op
import sqlalchemy as sa

revision = "003_knowledge_center"
down_revision = "002_memory_items"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "knowledge_bases",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("tenant_id", sa.String(length=36), nullable=False),
        sa.Column("workspace_id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("category", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_knowledge_bases_tenant_id", "knowledge_bases", ["tenant_id"])
    op.create_index(
        "ix_knowledge_bases_workspace_status",
        "knowledge_bases",
        ["workspace_id", "status"],
    )
    op.create_index(
        "ix_knowledge_bases_user_updated", "knowledge_bases", ["user_id", "updated_at"]
    )

    op.create_table(
        "knowledge_files",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("knowledge_id", sa.String(length=36), nullable=False),
        sa.Column("file_id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["knowledge_id"], ["knowledge_bases.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["file_id"], ["files.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("knowledge_id", "file_id"),
    )

    op.create_table(
        "knowledge_chunks",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("tenant_id", sa.String(length=36), nullable=False),
        sa.Column("workspace_id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("knowledge_id", sa.String(length=36), nullable=False),
        sa.Column("file_id", sa.String(length=36), nullable=True),
        sa.Column("chunk_index", sa.Integer(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("embedding_json", sa.Text(), nullable=True),
        sa.Column("metadata_json", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["knowledge_id"], ["knowledge_bases.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["file_id"], ["files.id"], ondelete="SET NULL"),
    )
    op.create_index("ix_knowledge_chunks_knowledge", "knowledge_chunks", ["knowledge_id"])
    op.create_index(
        "ix_knowledge_chunks_workspace_user",
        "knowledge_chunks",
        ["workspace_id", "user_id"],
    )
    op.create_index("ix_knowledge_chunks_file", "knowledge_chunks", ["file_id"])


def downgrade() -> None:
    op.drop_index("ix_knowledge_chunks_file", table_name="knowledge_chunks")
    op.drop_index("ix_knowledge_chunks_workspace_user", table_name="knowledge_chunks")
    op.drop_index("ix_knowledge_chunks_knowledge", table_name="knowledge_chunks")
    op.drop_table("knowledge_chunks")
    op.drop_table("knowledge_files")
    op.drop_index("ix_knowledge_bases_user_updated", table_name="knowledge_bases")
    op.drop_index("ix_knowledge_bases_workspace_status", table_name="knowledge_bases")
    op.drop_index("ix_knowledge_bases_tenant_id", table_name="knowledge_bases")
    op.drop_table("knowledge_bases")
