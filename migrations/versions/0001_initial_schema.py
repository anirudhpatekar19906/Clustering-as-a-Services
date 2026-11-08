"""Initial schema: users, datasets, experiments, and clustering jobs.

Revision ID: 0001
Revises:

The schema matches backend.models as introduced in File 6. Column defaults
such as UUID generation and timestamps are supplied by SQLAlchemy when
inserting ORM objects, rather than being database-server defaults.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# Alembic revision identifiers.
revision: str = "0001"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create the initial four application tables and their indexes."""
    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("password_hash", sa.String(512), nullable=False),
        sa.Column("display_name", sa.String(120), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    op.create_table(
        "datasets",
        sa.Column("id", sa.Uuid(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("owner_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("original_filename", sa.String(255), nullable=False),
        sa.Column("storage_key", sa.String(500), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("file_size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("row_count", sa.Integer(), nullable=True),
        sa.Column("column_count", sa.Integer(), nullable=True),
        sa.Column("column_names", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "file_size_bytes > 0", name="ck_datasets_positive_file_size"
        ),
        sa.CheckConstraint(
            "row_count IS NULL OR row_count >= 0", name="ck_datasets_row_count"
        ),
        sa.CheckConstraint(
            "column_count IS NULL OR column_count >= 0",
            name="ck_datasets_column_count",
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="RESTRICT"),
        sa.UniqueConstraint("storage_key"),
    )
    op.create_index("ix_datasets_owner_id", "datasets", ["owner_id"])

    op.create_table(
        "experiments",
        sa.Column("id", sa.Uuid(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("owner_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("dataset_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(150), nullable=False),
        sa.Column("algorithm", sa.String(40), nullable=False),
        sa.Column("n_clusters", sa.Integer(), nullable=False),
        sa.Column("model_version", sa.String(80), nullable=False),
        sa.Column("preprocessing_config", sa.JSON(), nullable=False),
        sa.Column("algorithm_config", sa.JSON(), nullable=False),
        sa.Column("cache_key", sa.String(64), nullable=True),
        sa.Column("metrics", sa.JSON(), nullable=True),
        sa.Column("centroids", sa.JSON(), nullable=True),
        sa.Column("result_storage_key", sa.String(500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("n_clusters >= 2", name="ck_experiments_min_clusters"),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(
            ["dataset_id"], ["datasets.id"], ondelete="RESTRICT"
        ),
    )
    op.create_index("ix_experiments_owner_id", "experiments", ["owner_id"])
    op.create_index("ix_experiments_dataset_id", "experiments", ["dataset_id"])
    op.create_index("ix_experiments_cache_key", "experiments", ["cache_key"])

    op.create_table(
        "clustering_jobs",
        sa.Column("id", sa.Uuid(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("experiment_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("rq_job_id", sa.String(128), nullable=True),
        sa.Column(
            "status",
            sa.Enum(
                "queued",
                "running",
                "succeeded",
                "failed",
                "cancelled",
                name="clustering_job_status",
                native_enum=False,
                create_constraint=True,
                length=16,
            ),
            nullable=False,
        ),
        sa.Column("cache_hit", sa.Boolean(), nullable=False),
        sa.Column("worker_name", sa.String(128), nullable=True),
        sa.Column("processing_time_ms", sa.Float(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "processing_time_ms IS NULL OR processing_time_ms >= 0",
            name="ck_clustering_jobs_nonnegative_duration",
        ),
        sa.ForeignKeyConstraint(
            ["experiment_id"], ["experiments.id"], ondelete="RESTRICT"
        ),
        sa.UniqueConstraint("rq_job_id"),
    )
    op.create_index(
        "ix_clustering_jobs_experiment_id", "clustering_jobs", ["experiment_id"]
    )
    op.create_index("ix_clustering_jobs_status", "clustering_jobs", ["status"])


def downgrade() -> None:
    """Remove the initial schema, in reverse dependency order (destructive)."""
    op.drop_index("ix_clustering_jobs_status", table_name="clustering_jobs")
    op.drop_index("ix_clustering_jobs_experiment_id", table_name="clustering_jobs")
    op.drop_table("clustering_jobs")

    op.drop_index("ix_experiments_cache_key", table_name="experiments")
    op.drop_index("ix_experiments_dataset_id", table_name="experiments")
    op.drop_index("ix_experiments_owner_id", table_name="experiments")
    op.drop_table("experiments")

    op.drop_index("ix_datasets_owner_id", table_name="datasets")
    op.drop_table("datasets")

    op.drop_index("ix_users_email", table_name="users")
    op.drop_table("users")
