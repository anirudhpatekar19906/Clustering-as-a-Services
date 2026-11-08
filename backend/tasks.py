"""RQ clustering task with permanent results and PostgreSQL job lifecycle.

File 42: keep the three task arguments and the File 38 CSV integrity checks.
Linked jobs from File 41 transition queued -> running -> succeeded (the ORM's
stored name for our public 'completed' state), or -> failed on errors.
Legacy jobs without experiment metadata still produce their original RQ result.
"""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from typing import Any
from uuid import UUID

import pandas as pd
from rq import get_current_job
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.database import get_session_factory
from backend.experiment_lifecycle import complete_experiment
from backend.experiment_store import load_completed_result
from backend.job_lifecycle import transition_clustering_job
from backend.models import Dataset, Experiment
from backend.queue_config import CLUSTERING_QUEUE_NAME
from backend.schemas.experiments import (
    ClusteringResultResponse,
    ExperimentCreateRequest,
)
from clustering_service.service import run_clustering
from configuration.settings import get_settings

logger = logging.getLogger("caas.tasks")
READ_CHUNK_SIZE = 1024 * 1024
TASK_FUNCTION = "backend.tasks.run_clustering_task"


def _owned_storage_path(upload_dir: Path, storage_key: str) -> Path:
    """Resolve a stored file without allowing paths outside uploads."""
    root = Path(upload_dir).resolve()
    target = (root / storage_key).resolve()
    if not target.is_relative_to(root):
        raise ValueError("Invalid dataset storage location")
    if not target.is_file():
        raise FileNotFoundError("Dataset file is unavailable")
    return target


def _file_digest(path: Path) -> tuple[int, str]:
    """Calculate file size and SHA-256 in small chunks."""
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(READ_CHUNK_SIZE):
            size += len(chunk)
            digest.update(chunk)
    return size, digest.hexdigest()


def process_dataset_file(
    csv_path: Path,
    request: ExperimentCreateRequest,
    *,
    expected_columns: list[str],
    expected_rows: int,
    expected_size: int,
    expected_sha256: str,
) -> dict[str, Any]:
    """Verify an uploaded CSV, then return a validated clustering result."""
    path = Path(csv_path)
    actual_size, actual_hash = _file_digest(path)
    if actual_size != expected_size or actual_hash != expected_sha256:
        raise ValueError("Stored CSV differs from its registered upload")

    if expected_rows < 2 or request.n_clusters > expected_rows:
        raise ValueError("Invalid cluster count for this dataset")

    try:
        frame = pd.read_csv(
            path,
            encoding="utf-8-sig",
            low_memory=False,
            on_bad_lines="error",
        )
    except (pd.errors.ParserError, pd.errors.EmptyDataError, UnicodeError) as exc:
        raise ValueError("Stored CSV cannot be parsed") from exc

    if list(frame.columns) != expected_columns:
        raise ValueError("Stored CSV columns differ from its metadata")
    if len(frame) != expected_rows:
        raise ValueError("Stored CSV row count differs from its metadata")

    result = run_clustering(frame, request.to_clustering_config())
    payload = result.to_dict(include_labels=True)
    validated = ClusteringResultResponse.model_validate(payload)
    return validated.model_dump(mode="json", exclude_none=True)


def _current_job_link(
    dataset_id: UUID,
    owner_id: UUID,
) -> tuple[UUID | None, UUID | None]:
    """Verify RQ metadata and return (experiment_id, rq_job_id).

    Older jobs without experiment_id remain supported. A linked job MUST
    match its queue, task function, dataset and owner before any DB update.
    """
    job = get_current_job()
    if job is None:
        return None, None

    meta = job.meta if isinstance(job.meta, dict) else {}
    raw_experiment_id = meta.get("experiment_id")
    if raw_experiment_id is None:
        logger.warning("RQ job %s has no experiment link (legacy job)", job.id)
        return None, None

    if (
        meta.get("type") != "clustering"
        or meta.get("dataset_id") != str(dataset_id)
        or meta.get("owner_id") != str(owner_id)
        or job.origin != CLUSTERING_QUEUE_NAME
        or job.func_name != TASK_FUNCTION
    ):
        raise ValueError("RQ job metadata does not match its clustering task")

    try:
        return UUID(str(raw_experiment_id)), UUID(str(job.id))
    except (TypeError, ValueError, AttributeError) as exc:
        raise ValueError("Invalid experiment or RQ job ID") from exc


def _require_linked_experiment(
    db: Session,
    experiment_id: UUID,
    dataset_id: UUID,
    owner_id: UUID,
    options: dict[str, Any],
    *,
    lock: bool = False,
) -> Experiment:
    """Confirm experiment ownership, dataset, and the submitted options."""
    statement = select(Experiment).where(
        Experiment.id == experiment_id,
        Experiment.dataset_id == dataset_id,
        Experiment.owner_id == owner_id,
    )
    if lock:
        statement = statement.with_for_update()

    experiment = db.scalar(statement)
    if experiment is None:
        raise ValueError("Linked experiment not found or belongs to another user")
    if experiment.algorithm_config != options:
        raise ValueError("Job settings differ from the saved experiment")
    return experiment


def _job_result(
    dataset_id: UUID,
    owner_id: UUID,
    result: dict[str, Any],
) -> dict[str, Any]:
    """Preserve the existing File 29/32 RQ result response shape."""
    return {
        "dataset_id": str(dataset_id),
        "owner_id": str(owner_id),
        "result": result,
    }


def _record_failed_job(
    experiment_id: UUID,
    rq_job_id: UUID,
    dataset_id: UUID,
    owner_id: UUID,
    options: dict[str, Any],
) -> None:
    """Best-effort failure persistence; never hide the original task error.

    Recheck the link before writing. A completed or cancelled job cannot be
    changed to failed; the lifecycle service rejects terminal transitions.
    """
    try:
        with get_session_factory()() as db:
            _require_linked_experiment(
                db, experiment_id, dataset_id, owner_id, options
            )
            transition_clustering_job(
                db,
                experiment_id=experiment_id,
                rq_job_id=rq_job_id,
                new_status="failed",
                error_message="Clustering task failed; check worker logs",
            )
            db.commit()
    except Exception:
        logger.exception(
            "Could not persist failure status for experiment=%s job=%s",
            experiment_id,
            rq_job_id,
        )


def run_clustering_task(
    dataset_id: str,
    owner_id: str,
    options: dict[str, Any],
) -> dict[str, Any]:
    """Run K-Means and persist both the result and the job's final state.

    Existing three-argument RQ interface is unchanged. Each transition is
    committed at the relevant stage; result + success status are committed
    together so we never report success in PostgreSQL without its result.
    """
    dataset_uuid = UUID(dataset_id)
    owner_uuid = UUID(owner_id)
    experiment_id, rq_job_id = _current_job_link(dataset_uuid, owner_uuid)
    normalized_options = options

    try:
        if "dataset_id" in options:
            raise ValueError("Pass dataset_id as a separate task argument")

        request = ExperimentCreateRequest.model_validate(
            {**options, "dataset_id": dataset_uuid}
        )
        normalized_options = request.model_dump(
            mode="json", exclude={"dataset_id"}
        )

        # Verify dataset and experiment ownership before reading file contents.
        with get_session_factory()() as db:
            record = db.scalar(
                select(Dataset).where(
                    Dataset.id == dataset_uuid,
                    Dataset.owner_id == owner_uuid,
                )
            )
            if record is None:
                raise ValueError("Dataset not found or unavailable")

            storage_key = record.storage_key
            columns = list(record.column_names or [])
            row_count = record.row_count
            size = record.file_size_bytes
            sha256 = record.sha256

            if experiment_id is not None and rq_job_id is not None:
                _require_linked_experiment(
                    db,
                    experiment_id,
                    dataset_uuid,
                    owner_uuid,
                    normalized_options,
                )

                # Retry: a previous worker may have committed the result.
                saved = load_completed_result(
                    db, experiment_id, include_labels=True
                )
                if saved is not None:
                    transition_clustering_job(
                        db,
                        experiment_id=experiment_id,
                        rq_job_id=rq_job_id,
                        new_status="completed",
                    )
                    db.commit()
                    logger.info("Reusing stored experiment %s", experiment_id)
                    return _job_result(dataset_uuid, owner_uuid, saved)

                transition_clustering_job(
                    db,
                    experiment_id=experiment_id,
                    rq_job_id=rq_job_id,
                    new_status="running",
                )
                # Commit 'running' before the potentially slow ML operation.
                db.commit()

        path = _owned_storage_path(get_settings().upload_dir, storage_key)
        result = process_dataset_file(
            path,
            request,
            expected_columns=columns,
            expected_rows=row_count,
            expected_size=size,
            expected_sha256=sha256,
        )

        if experiment_id is not None and rq_job_id is not None:
            with get_session_factory()() as db:
                # Lock the parent, serializing completion against retries.
                _require_linked_experiment(
                    db,
                    experiment_id,
                    dataset_uuid,
                    owner_uuid,
                    normalized_options,
                    lock=True,
                )
                saved = load_completed_result(
                    db, experiment_id, include_labels=True
                )
                if saved is None:
                    complete_experiment(db, experiment_id, result)
                else:
                    # Concurrent retry already committed an identical experiment.
                    result = saved

                transition_clustering_job(
                    db,
                    experiment_id=experiment_id,
                    rq_job_id=rq_job_id,
                    new_status="completed",
                )
                # A single transaction saves the ML result AND success state.
                db.commit()
                logger.info(
                    "Saved result and success status for experiment=%s job=%s",
                    experiment_id,
                    rq_job_id,
                )

        logger.info("Clustering finished for dataset %s", dataset_uuid)
        return _job_result(dataset_uuid, owner_uuid, result)

    except Exception:
        logger.exception("Clustering task failed for dataset %s", dataset_uuid)
        if experiment_id is not None and rq_job_id is not None:
            _record_failed_job(
                experiment_id,
                rq_job_id,
                dataset_uuid,
                owner_uuid,
                normalized_options,
            )
        raise
