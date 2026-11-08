"""Transactional PostgreSQL lifecycle helpers for ClusteringJob (File 40).

These functions do not commit, submit RQ jobs, or expose HTTP endpoints.
The submission API and worker will call them in later steps. Schema discovery
prevents guesses about the existing ClusteringJob's RQ identifier column.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal
from uuid import UUID, uuid4

from sqlalchemy import Enum as SAEnum, Uuid, inspect, select
from sqlalchemy.orm import Session

from backend.models import ClusteringJob, Experiment


JobState = Literal["queued", "running", "completed", "failed", "cancelled"]

_TRANSITIONS = {
    "queued": {"running", "completed", "failed", "cancelled"},
    "running": {"completed", "failed", "cancelled"},
    "completed": set(),
    "failed": set(),
    "cancelled": set(),
}

_ALIASES = {
    "pending": "queued",
    "created": "queued",
    "queued": "queued",
    "started": "running",
    "running": "running",
    "finished": "completed",
    "completed": "completed",
    "succeeded": "completed",
    "failed": "failed",
    "stopped": "failed",
    "canceled": "cancelled",
    "cancelled": "cancelled",
}


@dataclass(frozen=True)
class JobSchema:
    """Field names detected in the existing ORM mapping."""

    rq_id_field: str
    status_field: str
    columns: dict[str, Any]


def inspect_job_schema() -> JobSchema:
    """Check the mapped job table before attempting any database writes."""
    columns = {
        column.key: column
        for column in inspect(ClusteringJob).columns
    }

    required = {"id", "experiment_id", "status"}
    missing = sorted(required - columns.keys())

    if missing:
        raise RuntimeError(
            f"ClusteringJob is missing fields: {missing}"
        )

    candidates = (
        "rq_job_id",
        "redis_job_id",
        "queue_job_id",
        "job_id",
        "rq_id",
    )

    rq_id_field = next(
        (name for name in candidates if name in columns),
        None,
    )

    if rq_id_field is None:
        raise RuntimeError(
            "ClusteringJob needs an RQ job ID field. Available columns: "
            f"{sorted(columns)}. Share this output before integrating File 40."
        )

    status_column = columns["status"]

    if isinstance(status_column.type, SAEnum):
        available = {
            value.lower()
            for value in status_column.type.enums
        }

        if not (available & {"queued", "pending"}):
            raise RuntimeError(
                "ClusteringJob.status Enum lacks queued/pending: "
                f"{sorted(available)}"
            )

    return JobSchema(
        rq_id_field,
        "status",
        columns,
    )


def _normalize_state(raw: Any) -> str:
    """Convert SQLAlchemy Enum values or stored strings to public states."""
    if isinstance(raw, Enum):
        raw = raw.value if isinstance(raw.value, str) else raw.name

    value = str(raw).lower()

    if value not in _ALIASES:
        raise ValueError(
            f"Unsupported ClusteringJob status: {raw!r}"
        )

    return _ALIASES[value]


def _database_status(
    schema: JobSchema,
    state: JobState,
) -> Any:
    """Use the status vocabulary and Python Enum type expected by the ORM."""
    column_type = schema.columns[schema.status_field].type

    if isinstance(column_type, SAEnum):
        values = list(column_type.enums)

        preferred = {
            "queued": ("queued", "pending"),
            "running": ("running", "started"),
            "completed": ("succeeded", "completed", "finished"),
            "failed": ("failed",),
            "cancelled": ("cancelled", "canceled"),
        }[state]

        matching = next(
            (
                value
                for alias in preferred
                for value in values
                if value.lower() == alias
            ),
            None,
        )

        if matching is None:
            raise RuntimeError(
                f"ClusteringJob.status Enum lacks a {state!r} state"
            )

        if column_type.enum_class is not None:
            for member in column_type.enum_class:
                if (
                    member.name == matching
                    or member.value == matching
                ):
                    return member

            raise RuntimeError(
                f"Cannot map {matching!r} to the status Enum class"
            )

        return matching

    return state


def _rq_identifier(
    schema: JobSchema,
    job_id: UUID,
) -> str | UUID:
    """Match the ORM column's UUID or string storage format."""
    column_type = schema.columns[schema.rq_id_field].type

    return (
        job_id
        if isinstance(column_type, Uuid)
        else str(job_id)
    )


def _require_no_unknown_required_fields(
    schema: JobSchema,
    values: dict[str, Any],
) -> None:
    """Reject unmapped required columns before attempting an insert."""
    missing = [
        name
        for name, column in schema.columns.items()
        if name not in values
        and not column.nullable
        and column.default is None
        and column.server_default is None
        and column.computed is None
        and not (
            column.primary_key
            and column.autoincrement is True
        )
    ]

    if missing:
        raise RuntimeError(
            "ClusteringJob has required fields not supported by this service: "
            f"{sorted(missing)}"
        )


def stage_clustering_job(
    db: Session,
    *,
    experiment_id: UUID,
    owner_id: UUID,
    rq_job_id: UUID,
) -> ClusteringJob:
    """Stage a queued job for an owned experiment; caller must commit.

    The RQ ID should be chosen in advance so the API can store it before
    enqueueing. Existing matching rows are returned for retry safety.
    """
    schema = inspect_job_schema()

    parent = db.scalar(
        select(Experiment.id).where(
            Experiment.id == experiment_id,
            Experiment.owner_id == owner_id,
        )
    )

    if parent is None:
        raise ValueError(
            "Experiment not found or not owned by user"
        )

    stored_rq_id = _rq_identifier(schema, rq_job_id)

    existing = db.scalar(
        select(ClusteringJob).where(
            getattr(
                ClusteringJob,
                schema.rq_id_field,
            ) == stored_rq_id
        )
    )

    if existing is not None:
        if existing.experiment_id != experiment_id:
            raise ValueError(
                "RQ job ID already belongs to another experiment"
            )

        return existing

    values: dict[str, Any] = {
        "id": uuid4(),
        "experiment_id": experiment_id,
        schema.rq_id_field: stored_rq_id,
        "status": _database_status(schema, "queued"),
    }

    if "owner_id" in schema.columns:
        values["owner_id"] = owner_id

    if "queue_name" in schema.columns:
        values["queue_name"] = "clustering"

    if (
        "error_message" in schema.columns
        and not schema.columns["error_message"].nullable
    ):
        values["error_message"] = ""

    _require_no_unknown_required_fields(
        schema,
        values,
    )

    record = ClusteringJob(**values)
    db.add(record)
    db.flush()

    return record


def transition_clustering_job(
    db: Session,
    *,
    experiment_id: UUID,
    rq_job_id: UUID,
    new_status: JobState,
    error_message: str | None = None,
) -> ClusteringJob:
    """Lock the job and stage a valid status transition without committing.

    The worker should mark 'completed' in the SAME transaction that saves
    the completed ML result, not before it.
    """
    if new_status not in _TRANSITIONS:
        raise ValueError(
            f"Unsupported new job state: {new_status!r}"
        )

    schema = inspect_job_schema()

    record = db.scalar(
        select(ClusteringJob)
        .where(
            ClusteringJob.experiment_id == experiment_id,
            getattr(
                ClusteringJob,
                schema.rq_id_field,
            ) == _rq_identifier(schema, rq_job_id),
        )
        .with_for_update()
    )

    if record is None:
        raise ValueError("Clustering job not found")

    previous = _normalize_state(record.status)

    if previous == new_status:
        return record

    if new_status not in _TRANSITIONS[previous]:
        raise ValueError(
            f"Invalid job transition: {previous} -> {new_status}"
        )

    record.status = _database_status(
        schema,
        new_status,
    )

    now = datetime.now(timezone.utc)

    if (
        new_status == "running"
        and "started_at" in schema.columns
    ):
        record.started_at = now

    if new_status in {"completed", "failed", "cancelled"}:
        for field in (
            "finished_at",
            "ended_at",
            "completed_at",
        ):
            if field in schema.columns:
                setattr(record, field, now)
                break

    if (
        new_status == "failed"
        and "error_message" in schema.columns
    ):
        record.error_message = (
            error_message or "Clustering failed"
        )[:2000]

    db.flush()

    return record


def get_owned_clustering_job(
    db: Session,
    *,
    rq_job_id: UUID,
    owner_id: UUID,
) -> ClusteringJob | None:
    """Read a job through its parent experiment to enforce ownership."""
    schema = inspect_job_schema()

    return db.scalar(
        select(ClusteringJob)
        .join(
            Experiment,
            ClusteringJob.experiment_id == Experiment.id,
        )
        .where(
            getattr(
                ClusteringJob,
                schema.rq_id_field,
            ) == _rq_identifier(schema, rq_job_id),
            Experiment.owner_id == owner_id,
        )
    )
