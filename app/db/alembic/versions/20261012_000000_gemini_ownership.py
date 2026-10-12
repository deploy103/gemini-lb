"""Persist Google source ownership and model-scoped quota cooldowns."""

import sqlalchemy as sa
from alembic import op

revision = "20261012_000000_gemini_ownership"
down_revision = "20260918_000000_merge_scim_and_overflow_heads"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("gemini_sessions"):
        op.create_table(
            "gemini_sessions",
            sa.Column("session_hash", sa.String(64), primary_key=True),
            sa.Column("source_id", sa.String(), nullable=False),
            sa.Column("expires_at", sa.DateTime(), nullable=False),
        )
    inspector.clear_cache()
    if "ix_gemini_sessions_expires_at" not in {index["name"] for index in inspector.get_indexes("gemini_sessions")}:
        op.create_index("ix_gemini_sessions_expires_at", "gemini_sessions", ["expires_at"])
    if not inspector.has_table("gemini_cooldowns"):
        op.create_table(
            "gemini_cooldowns",
            sa.Column("quota_hash", sa.String(64), primary_key=True),
            sa.Column("model", sa.String(255), primary_key=True),
            sa.Column("expires_at", sa.DateTime(), nullable=False),
        )
    inspector.clear_cache()
    if "ix_gemini_cooldowns_expires_at" not in {index["name"] for index in inspector.get_indexes("gemini_cooldowns")}:
        op.create_index("ix_gemini_cooldowns_expires_at", "gemini_cooldowns", ["expires_at"])
    if not inspector.has_table("gemini_quotas"):
        op.create_table(
            "gemini_quotas",
            sa.Column("source_id", sa.String(), primary_key=True),
            sa.Column("snapshot_json", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
        )


def downgrade() -> None:
    op.drop_table("gemini_quotas")
    op.drop_table("gemini_cooldowns")
    op.drop_table("gemini_sessions")
