"""Persistent ORM models for the Clustering-as-a-Service platform.

Import these models before running Alembic migrations or creating test tables.
Dataset files and potentially large cluster-label arrays live in object/file
storage; the database keeps metadata and storage keys instead.
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Enum as SQLEnum,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.database import Base


def utc_now() -> datetime:
    """Return a timezone-aware UTC timestamp for new/updated ORM records."""
    return datetime.now(timezone.utc)


class TimestampMixin:
    """Common audit timestamps (updated on SQLAlchemy-managed updates)."""

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False
    )


class JobStatus(str, Enum):
    """Lifecycle of a clustering execution, not of the experiment itself."""

    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class User(TimestampMixin, Base):
    __tablename__ = "users"

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(512), nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(120))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    datasets: Mapped[list[Dataset]] = relationship(back_populates="owner")
    experiments: Mapped[list[Experiment]] = relationship(back_populates="owner")


class Dataset(TimestampMixin, Base):
    __tablename__ = "datasets"
    __table_args__ = (
        CheckConstraint("file_size_bytes > 0", name="ck_datasets_positive_file_size"),
        CheckConstraint("row_count IS NULL OR row_count >= 0", name="ck_datasets_row_count"),
        CheckConstraint("column_count IS NULL OR column_count >= 0", name="ck_datasets_column_count"),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    owner_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), index=True, nullable=False
    )
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    storage_key: Mapped[str] = mapped_column(String(500), unique=True, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    file_size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    row_count: Mapped[int | None] = mapped_column(Integer)
    column_count: Mapped[int | None] = mapped_column(Integer)
    column_names: Mapped[list[str] | None] = mapped_column(JSON)

    owner: Mapped[User] = relationship(back_populates="datasets")
    experiments: Mapped[list[Experiment]] = relationship(back_populates="dataset")


class Experiment(TimestampMixin, Base):
    __tablename__ = "experiments"
    __table_args__ = (
        CheckConstraint("n_clusters >= 2", name="ck_experiments_min_clusters"),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    owner_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), index=True, nullable=False
    )
    dataset_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("datasets.id", ondelete="RESTRICT"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    algorithm: Mapped[str] = mapped_column(String(40), default="custom_kmeans", nullable=False)
    n_clusters: Mapped[int] = mapped_column(Integer, nullable=False)
    model_version: Mapped[str] = mapped_column(String(80), default="kmeans-v1", nullable=False)
    preprocessing_config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    algorithm_config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    cache_key: Mapped[str | None] = mapped_column(String(64), index=True)
    metrics: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    centroids: Mapped[list[list[float]] | None] = mapped_column(JSON)
    result_storage_key: Mapped[str | None] = mapped_column(String(500))

    owner: Mapped[User] = relationship(back_populates="experiments")
    dataset: Mapped[Dataset] = relationship(back_populates="experiments")
    jobs: Mapped[list[ClusteringJob]] = relationship(back_populates="experiment")


class ClusteringJob(TimestampMixin, Base):
    __tablename__ = "clustering_jobs"
    __table_args__ = (
        CheckConstraint(
            "processing_time_ms IS NULL OR processing_time_ms >= 0",
            name="ck_clustering_jobs_nonnegative_duration",
        ),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    experiment_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("experiments.id", ondelete="RESTRICT"), index=True, nullable=False
    )
    rq_job_id: Mapped[str | None] = mapped_column(String(128), unique=True)
    status: Mapped[JobStatus] = mapped_column(
        SQLEnum(
            JobStatus,
            values_callable=lambda enum_type: [item.value for item in enum_type],
            native_enum=False,
            create_constraint=True,
            length=16,
            name="clustering_job_status",
        ),
        default=JobStatus.QUEUED,
        index=True,
        nullable=False,
    )
    cache_hit: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    worker_name: Mapped[str | None] = mapped_column(String(128))
    processing_time_ms: Mapped[float | None] = mapped_column(Float)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error_message: Mapped[str | None] = mapped_column(Text)

    experiment: Mapped[Experiment] = relationship(back_populates="jobs")


from datetime import datetime as _datetime
from typing import Any as _Any
from uuid import UUID as _UUID

import sqlalchemy as _sa
from sqlalchemy.orm import Mapped as _Mapped, mapped_column as _mapped_column


class ExperimentResult(Base):
    """Persist one completed clustering output per experiment.

    Ownership and authorization are determined through the parent Experiment.
    This model does not create or submit background jobs.
    """

    __tablename__ = "experiment_results"

    experiment_id: _Mapped[_UUID] = _mapped_column(
        _sa.Uuid(as_uuid=True),
        _sa.ForeignKey("experiments.id", ondelete="CASCADE"),
        primary_key=True,
    )

    model_version: _Mapped[str] = _mapped_column(
        _sa.String(64),
        nullable=False,
    )

    result_json: _Mapped[dict[str, _Any]] = _mapped_column(
        _sa.JSON(),
        nullable=False,
    )

    completed_at: _Mapped[_datetime] = _mapped_column(
        _sa.DateTime(timezone=True),
        nullable=False,
        server_default=_sa.func.now(),
    )
