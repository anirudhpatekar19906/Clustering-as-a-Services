"""Persist completed clustering outputs independently of temporary RQ results.

Revision ID: 0002
Revises: 0001

The existing ``experiments`` table represents an experiment's identity,
configuration, ownership and lifecycle. This companion table stores its
completed ML output (centroids, metrics, labels and preprocessing metadata).

A primary-key foreign key guarantees at most one result per experiment. The
ON DELETE CASCADE constraint removes an output when its parent experiment is
deleted. Authorization must always be checked through the parent experiment;
this table deliberately has no independent public API.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    """Create durable storage for completed clustering results."""
    op.create_table(
        "experiment_results",
        sa.Column(
            "experiment_id",
            sa.Uuid(as_uuid=True),
            sa.ForeignKey("experiments.id", ondelete="CASCADE"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column("model_version", sa.String(length=64), nullable=False),
        sa.Column("result_json", sa.JSON(), nullable=False),
        sa.Column(
            "completed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )


def downgrade() -> None:
    """Remove persisted clustering results (destructive rollback)."""
    op.drop_table("experiment_results")
