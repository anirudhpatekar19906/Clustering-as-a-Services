"""Authenticated experiment submission, history, and persistent job status.

New jobs are backed by PostgreSQL ClusteringJob rows and permanent result
storage. Older jobs without a database row still use Redis/RQ while retained.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from redis.exceptions import RedisError
from rq.exceptions import NoSuchJobError
from rq.job import Job
from sqlalchemy import Uuid, func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.experiment_lifecycle import get_owned_experiment, stage_experiment
from backend.experiment_store import load_completed_result
from backend.job_lifecycle import _normalize_state, stage_clustering_job
from backend.models import ClusteringJob, Dataset, Experiment, ExperimentResult, User
from backend.queue_config import (
    CLUSTERING_QUEUE_NAME,
    get_clustering_queue,
    get_redis_connection,
)
from backend.routers.auth import get_current_user
from backend.schemas.experiments import (
    ClusteringResultResponse,
    ExperimentCreateRequest,
    ExperimentStatus,
)

logger = logging.getLogger("caas.experiments")
router = APIRouter(prefix="/experiments", tags=["Experiments"])
TASK_FUNCTION = "backend.tasks.run_clustering_task"


class ExperimentPreflightResponse(BaseModel):
    """Checks saved dataset metadata, not the numerical contents of the CSV."""

    model_config = ConfigDict(extra="forbid")

    dataset_id: UUID
    n_clusters: int = Field(ge=2)
    dataset_rows: int = Field(ge=2)
    available_columns: list[str]
    selected_features: list[str] | None
    feature_selection: Literal["automatic", "explicit"]
    validation_scope: Literal["metadata_only"] = "metadata_only"
    message: str = (
        "Dataset ownership and metadata checks passed. "
        "Numeric data and clustering feasibility will be checked during execution."
    )


class ClusteringJobSubmittedResponse(BaseModel):
    """Receipt for a persisted Experiment and a submitted RQ job."""

    model_config = ConfigDict(extra="forbid")

    experiment_id: UUID
    job_id: UUID
    dataset_id: UUID
    status: Literal["submitted"] = "submitted"
    message: str = (
        "Experiment created and job submitted to the clustering queue. "
        "Use GET /api/v1/experiments/{job_id} to check its status."
    )


class ClusteringJobStatusResponse(BaseModel):
    """Owner-scoped status, with optional validated permanent ML results."""

    model_config = ConfigDict(extra="forbid")

    job_id: UUID
    dataset_id: UUID
    status: ExperimentStatus
    message: str
    # Additive fields; existing job-status clients can retain their old keys.
    experiment_id: UUID | None = None
    status_source: Literal["postgresql", "redis"] = "redis"
    recorded_at: datetime | None = None
    enqueued_at: datetime | None = None
    started_at: datetime | None = None
    ended_at: datetime | None = None
    result: ClusteringResultResponse | None = None



class ExperimentHistoryItemResponse(BaseModel):
    """Small experiment summary without expensive result JSON or cluster labels."""

    model_config = ConfigDict(extra="forbid")

    experiment_id: UUID
    dataset_id: UUID
    name: str | None
    algorithm: str
    model_version: str | None
    n_clusters: int = Field(ge=2)
    created_at: datetime
    updated_at: datetime | None = None
    result_available: bool


class ExperimentHistoryListResponse(BaseModel):
    """Paginated owner-scoped experiment history."""

    model_config = ConfigDict(extra="forbid")

    items: list[ExperimentHistoryItemResponse]
    total: int = Field(ge=0)
    limit: int = Field(ge=1, le=100)
    offset: int = Field(ge=0)


class ExperimentHistoryDetailResponse(ExperimentHistoryItemResponse):
    """One owned experiment, with an optional permanent clustering result."""

    algorithm_config: dict[str, Any]
    preprocessing_config: dict[str, Any] | None = None
    result: ClusteringResultResponse | None = None


def get_owned_dataset(db: Session, dataset_id: UUID, user_id: UUID) -> Dataset:
    """Find a dataset without revealing another user's records."""
    dataset = db.scalar(
        select(Dataset).where(
            Dataset.id == dataset_id,
            Dataset.owner_id == user_id,
        )
    )
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")
    return dataset


def check_experiment_metadata(
    request: ExperimentCreateRequest,
    dataset: Dataset,
) -> None:
    """Reject cluster counts and feature names contradicted by metadata."""
    if dataset.row_count is None or dataset.row_count < 2:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Dataset must contain at least two data rows",
        )
    if request.n_clusters > dataset.row_count:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="n_clusters cannot exceed the dataset row count",
        )

    available = dataset.column_names or []
    if not available:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Dataset column metadata is unavailable",
        )
    if request.features is not None:
        unknown = [name for name in request.features if name not in available]
        if unknown:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail={"unknown_features": unknown},
            )


@router.post(
    "/preflight",
    response_model=ExperimentPreflightResponse,
    status_code=status.HTTP_200_OK,
    summary="Validate an experiment before submission",
)
def preflight_experiment(
    request: ExperimentCreateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ExperimentPreflightResponse:
    """Check ownership and metadata without enqueueing work."""
    dataset = get_owned_dataset(db, request.dataset_id, current_user.id)
    check_experiment_metadata(request, dataset)
    return ExperimentPreflightResponse(
        dataset_id=dataset.id,
        n_clusters=request.n_clusters,
        dataset_rows=dataset.row_count,
        available_columns=list(dataset.column_names),
        selected_features=(
            list(request.features) if request.features is not None else None
        ),
        feature_selection=(
            "explicit" if request.features is not None else "automatic"
        ),
    )


@router.post(
    "",
    response_model=ClusteringJobSubmittedResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Submit a clustering job to Redis/RQ",
)
def submit_experiment(
    request: ExperimentCreateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ClusteringJobSubmittedResponse:
    """Commit an Experiment and its queued ClusteringJob before RQ enqueue.

    Both PostgreSQL rows are committed together so a fast worker can find
    them immediately. Redis and PostgreSQL are not one atomic transaction:
    an enqueue timeout is ambiguous, so saved records remain available for
    later reconciliation instead of being deleted or incorrectly marked failed.
    """
    dataset = get_owned_dataset(db, request.dataset_id, current_user.id)
    check_experiment_metadata(request, dataset)

    dataset_id = dataset.id
    owner_id = current_user.id
    options = request.model_dump(mode="json", exclude={"dataset_id"})

    # Do not write to PostgreSQL when Redis is already unreachable.
    try:
        queue = get_clustering_queue()
        queue.connection.ping()
    except RedisError as exc:
        logger.exception("Clustering queue unavailable before submission")
        raise HTTPException(
            status_code=503,
            detail="Clustering queue is temporarily unavailable",
        ) from exc

    # Choose the exact RQ ID up front; PostgreSQL and Redis use the same ID.
    rq_job_id = uuid4()

    try:
        experiment = stage_experiment(
            db,
            owner_id=owner_id,
            request=request,
        )
        experiment_id = experiment.id
        stage_clustering_job(
            db,
            experiment_id=experiment_id,
            owner_id=owner_id,
            rq_job_id=rq_job_id,
        )
        # Atomic PostgreSQL commit of BOTH rows, before any worker can start.
        db.commit()
    except (SQLAlchemyError, RuntimeError, ValueError) as exc:
        db.rollback()
        logger.exception(
            "Could not persist experiment and queued job for dataset %s",
            dataset_id,
        )
        raise HTTPException(
            status_code=500,
            detail="Could not create experiment and job records",
        ) from exc
    except Exception:
        db.rollback()
        raise

    try:
        job = queue.enqueue_call(
            func=TASK_FUNCTION,
            args=(str(dataset_id), str(owner_id), options),
            job_id=str(rq_job_id),
            result_ttl=86400,
            failure_ttl=604800,
            meta={
                "owner_id": str(owner_id),
                "dataset_id": str(dataset_id),
                "experiment_id": str(experiment_id),
                "type": "clustering",
            },
            description=f"Cluster dataset {dataset_id}",
        )
    except RedisError as exc:
        # A Redis timeout does not prove the job was rejected. Preserve the
        # pre-committed queued row and its exact RQ ID for reconciliation.
        logger.exception(
            "RQ enqueue unconfirmed: experiment=%s rq_job=%s",
            experiment_id,
            rq_job_id,
        )
        raise HTTPException(
            status_code=503,
            detail={
                "message": "Job submission could not be confirmed; do not retry blindly.",
                "experiment_id": str(experiment_id),
                "job_id": str(rq_job_id),
                "state": "unconfirmed",
            },
        ) from exc

    # RQ must honor the explicitly supplied ID. A mismatch needs repair,
    # because an unexpected job ID would not match our persisted record.
    if str(job.id) != str(rq_job_id):
        logger.error(
            "RQ job ID mismatch: expected=%s returned=%s experiment=%s",
            rq_job_id,
            job.id,
            experiment_id,
        )
        raise HTTPException(
            status_code=503,
            detail="Job ID mismatch after enqueue; reconciliation is required",
        )

    logger.info(
        "Submitted experiment %s with persistent job %s for dataset %s",
        experiment_id,
        rq_job_id,
        dataset_id,
    )
    return ClusteringJobSubmittedResponse(
        experiment_id=experiment_id,
        job_id=rq_job_id,
        dataset_id=dataset_id,
    )


def get_owned_clustering_job(job_id: UUID, user_id: UUID) -> Job:
    """Fetch only a clustering job owned by the logged-in user.

    Use the same 404 response for unknown IDs and other users' jobs.
    Never inspect the job's arguments or result before verifying ownership.
    """
    try:
        job = Job.fetch(str(job_id), connection=get_redis_connection())
        metadata = job.get_meta(refresh=True)
    except NoSuchJobError as exc:
        raise HTTPException(status_code=404, detail="Job not found") from exc
    except RedisError as exc:
        logger.exception("Could not retrieve RQ job status")
        raise HTTPException(
            status_code=503, detail="Clustering queue is temporarily unavailable"
        ) from exc

    if (
        not isinstance(metadata, dict)
        or metadata.get("owner_id") != str(user_id)
        or metadata.get("type") != "clustering"
        or not isinstance(metadata.get("dataset_id"), str)
        or job.origin != CLUSTERING_QUEUE_NAME
        or job.func_name != TASK_FUNCTION
    ):
        raise HTTPException(status_code=404, detail="Job not found")

    return job


def _public_job_status(raw_status: object) -> ExperimentStatus:
    """Translate RQ's states into the stable public API states."""
    state = str(getattr(raw_status, "value", raw_status))
    mapping: dict[str, ExperimentStatus] = {
        "created": "queued",
        "queued": "queued",
        "deferred": "queued",
        "scheduled": "queued",
        "rate_limited": "queued",
        "ready_to_enqueue": "queued",
        "started": "running",
        "finished": "completed",
        "failed": "failed",
        "stopped": "failed",
        "canceled": "cancelled",
    }
    if state not in mapping:
        raise HTTPException(status_code=503, detail="Job status unavailable")
    return mapping[state]



@router.get(
    "/history",
    response_model=ExperimentHistoryListResponse,
    summary="List the current user's saved experiments",
)
def list_experiment_history(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ExperimentHistoryListResponse:
    """List experiment metadata without loading potentially huge result JSON."""
    owner_filter = Experiment.owner_id == current_user.id
    total = db.scalar(
        select(func.count(Experiment.id)).where(owner_filter)
    ) or 0

    rows = db.execute(
        select(
            Experiment.id,
            Experiment.dataset_id,
            Experiment.name,
            Experiment.algorithm,
            Experiment.model_version,
            Experiment.n_clusters,
            Experiment.created_at,
            Experiment.updated_at,
            ExperimentResult.experiment_id,
        )
        .select_from(Experiment)
        .outerjoin(
            ExperimentResult,
            ExperimentResult.experiment_id == Experiment.id,
        )
        .where(owner_filter)
        .order_by(Experiment.created_at.desc(), Experiment.id.desc())
        .offset(offset)
        .limit(limit)
    ).all()

    return ExperimentHistoryListResponse(
        items=[
            ExperimentHistoryItemResponse(
                experiment_id=experiment_id,
                dataset_id=dataset_id,
                name=name,
                algorithm=algorithm,
                model_version=model_version,
                n_clusters=n_clusters,
                created_at=created_at,
                updated_at=updated_at,
                result_available=(saved_id is not None),
            )
            for (
                experiment_id,
                dataset_id,
                name,
                algorithm,
                model_version,
                n_clusters,
                created_at,
                updated_at,
                saved_id,
            ) in rows
        ],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get(
    "/history/{experiment_id}",
    response_model=ExperimentHistoryDetailResponse,
    summary="Retrieve a saved experiment and its permanent result",
)
def get_experiment_history_detail(
    experiment_id: UUID,
    include_labels: bool = Query(
        default=False,
        description="Include all cluster assignments if a result is saved",
    ),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ExperimentHistoryDetailResponse:
    """Authorize against the parent experiment before reading stored output."""
    experiment = get_owned_experiment(db, experiment_id, current_user.id)
    if experiment is None:
        raise HTTPException(status_code=404, detail="Experiment not found")

    try:
        saved_result = load_completed_result(
            db,
            experiment_id,
            include_labels=include_labels,
        )
        result = (
            ClusteringResultResponse.model_validate(saved_result)
            if saved_result is not None
            else None
        )
    except (ValueError, TypeError, ValidationError) as exc:
        logger.exception("Invalid stored result for experiment %s", experiment_id)
        raise HTTPException(
            status_code=502, detail="Saved experiment result unavailable"
        ) from exc

    return ExperimentHistoryDetailResponse(
        experiment_id=experiment.id,
        dataset_id=experiment.dataset_id,
        name=experiment.name,
        algorithm=experiment.algorithm,
        model_version=experiment.model_version,
        n_clusters=experiment.n_clusters,
        created_at=experiment.created_at,
        updated_at=experiment.updated_at,
        result_available=(result is not None),
        algorithm_config=dict(experiment.algorithm_config or {}),
        preprocessing_config=(
            dict(experiment.preprocessing_config)
            if experiment.preprocessing_config is not None
            else None
        ),
        result=result,
    )


def _read_persisted_job_status(
    db: Session,
    *,
    job_id: UUID,
    user_id: UUID,
    include_labels: bool,
) -> ClusteringJobStatusResponse | None:
    """Look up a database-backed job before using Redis/RQ.

    Query by RQ ID first. A matching row owned by somebody else gets a 404,
    never a fallback to Redis. This preserves ownership across Redis expiry.
    """
    rq_column = ClusteringJob.__table__.columns["rq_job_id"]
    stored_id = job_id if isinstance(rq_column.type, Uuid) else str(job_id)

    row = db.execute(
        select(ClusteringJob, Experiment.dataset_id, Experiment.owner_id)
        .join(Experiment, ClusteringJob.experiment_id == Experiment.id)
        .where(ClusteringJob.rq_job_id == stored_id)
    ).one_or_none()

    if row is None:
        return None  # Old RQ-only job; retain the original Redis behavior.

    saved_job, dataset_id, actual_owner_id = row
    if actual_owner_id != user_id:
        raise HTTPException(status_code=404, detail="Job not found")

    try:
        public_status: ExperimentStatus = _normalize_state(saved_job.status)
    except ValueError as exc:
        logger.exception("Unknown persisted job status for %s", job_id)
        raise HTTPException(
            status_code=503, detail="Job status unavailable"
        ) from exc

    result: ClusteringResultResponse | None = None
    if public_status == "completed":
        try:
            stored_result = load_completed_result(
                db,
                saved_job.experiment_id,
                include_labels=include_labels,
            )
            if stored_result is not None:
                result = ClusteringResultResponse.model_validate(stored_result)
        except (ValueError, TypeError, ValidationError) as exc:
            logger.exception("Corrupt saved result for job %s", job_id)
            raise HTTPException(
                status_code=502, detail="Saved job result unavailable"
            ) from exc

    messages = {
        "queued": (
            "Job is recorded as queued. Redis delivery may be unconfirmed "
            "until a worker starts it."
        ),
        "running": (
            "Worker marked the job as running. If interrupted, "
            "its status may need reconciliation."
        ),
        "completed": (
            "Clustering completed; result loaded from PostgreSQL."
            if result is not None
            else "Clustering succeeded, but its saved result is unavailable."
        ),
        "failed": "Clustering failed. Internal error details are not exposed.",
        "cancelled": "Clustering job was cancelled.",
    }

    return ClusteringJobStatusResponse(
        job_id=job_id,
        dataset_id=dataset_id,
        experiment_id=saved_job.experiment_id,
        status_source="postgresql",
        status=public_status,
        message=messages[public_status],
        recorded_at=getattr(saved_job, "created_at", None),
        # PostgreSQL creation time is NOT proof of successful RQ enqueue.
        enqueued_at=None,
        started_at=saved_job.started_at,
        ended_at=saved_job.completed_at,
        result=result,
    )


@router.get(
    "/{job_id}",
    response_model=ClusteringJobStatusResponse,
    summary="Get the status and result of an owned clustering job",
)
def get_clustering_job_status(
    job_id: UUID,
    include_labels: bool = Query(
        default=False,
        description="Include per-row cluster labels in the completed result",
    ),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ClusteringJobStatusResponse:
    """Prefer permanent PostgreSQL status; use Redis for older RQ-only jobs.

    Database-backed jobs can be queried after Redis expires or goes offline.
    Only owner-checked records are returned and internal errors stay private.
    The DB state is the last committed worker update, not a live heartbeat.
    """
    persisted = _read_persisted_job_status(
        db,
        job_id=job_id,
        user_id=current_user.id,
        include_labels=include_labels,
    )
    if persisted is not None:
        return persisted

    # Backward compatibility: jobs queued before ClusteringJob was persisted.
    job = get_owned_clustering_job(job_id, current_user.id)
    try:
        dataset_id = UUID(job.meta["dataset_id"])
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=404, detail="Job not found") from exc

    try:
        public_status = _public_job_status(job.get_status(refresh=True))
        result: ClusteringResultResponse | None = None
        if public_status == "completed":
            payload = job.return_value()
            if payload is not None:
                if (
                    not isinstance(payload, dict)
                    or payload.get("owner_id") != str(current_user.id)
                    or payload.get("dataset_id") != str(dataset_id)
                    or not isinstance(payload.get("result"), dict)
                ):
                    logger.error("Invalid result envelope for job %s", job_id)
                    raise HTTPException(
                        status_code=502, detail="Job result unavailable"
                    )
                try:
                    result = ClusteringResultResponse.model_validate(
                        payload["result"]
                    )
                except ValidationError as exc:
                    logger.error("Invalid clustering result for job %s", job_id)
                    raise HTTPException(
                        status_code=502, detail="Job result unavailable"
                    ) from exc
                if not include_labels:
                    result = result.model_copy(update={"labels": None})
    except RedisError as exc:
        logger.exception("Could not read RQ job %s", job_id)
        raise HTTPException(
            status_code=503, detail="Clustering queue is temporarily unavailable"
        ) from exc

    messages = {
        "queued": "Job is waiting for a worker.",
        "running": "Clustering is in progress.",
        "completed": (
            "Clustering completed."
            if result is not None
            else "Clustering completed, but its result is unavailable."
        ),
        "failed": "Clustering failed. Internal error details are not exposed.",
        "cancelled": "Clustering job was cancelled.",
    }

    experiment_id: UUID | None = None
    raw_experiment_id = job.meta.get("experiment_id")
    if raw_experiment_id is not None:
        try:
            experiment_id = UUID(str(raw_experiment_id))
        except (TypeError, ValueError):
            pass

    return ClusteringJobStatusResponse(
        job_id=job_id,
        dataset_id=dataset_id,
        experiment_id=experiment_id,
        status_source="redis",
        status=public_status,
        message=messages[public_status],
        enqueued_at=job.enqueued_at,
        started_at=job.started_at,
        ended_at=job.ended_at,
        result=result,
    )
