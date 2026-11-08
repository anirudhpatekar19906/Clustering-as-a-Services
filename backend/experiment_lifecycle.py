"""Transactional experiment creation and completion helpers.

Experiment stores configuration and results. ClusteringJob owns job status.
These helpers do not commit sessions or enqueue RQ jobs.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import JSON, inspect, select
from sqlalchemy.orm import Session

from backend.experiment_store import save_completed_result
from backend.models import Experiment
from backend.schemas.experiments import ExperimentCreateRequest


MODEL_VERSION = "kmeans-v1"
ALGORITHM = "custom_kmeans"


def _schema() -> tuple[dict[str, Any], str, str]:
    """Validate the existing Experiment ORM structure."""
    columns = {
        column.key: column
        for column in inspect(Experiment).columns
    }

    required = {
        "id",
        "dataset_id",
        "owner_id",
        "algorithm_config",
    }
    missing = sorted(required - set(columns))

    if missing:
        raise RuntimeError(
            f"Experiment ORM is missing columns: {missing}"
        )

    if not isinstance(columns["algorithm_config"].type, JSON):
        raise RuntimeError(
            "Experiment.algorithm_config must be a JSON column"
        )

    return columns, "owner_id", "algorithm_config"


def stage_experiment(
    db: Session,
    *,
    owner_id: UUID,
    request: ExperimentCreateRequest,
) -> Experiment:
    """Stage an experiment after the caller verifies dataset ownership.

    Does not commit the transaction.
    """
    columns, owner_column, config_column = _schema()

    options = request.model_dump(
        mode="json",
        exclude={"dataset_id"},
    )

    values: dict[str, Any] = {
        "id": uuid4(),
        "dataset_id": request.dataset_id,
        owner_column: owner_id,
        config_column: options,
    }

    optional_values = {
        "algorithm": ALGORITHM,
        "n_clusters": request.n_clusters,
        "name": "K-Means clustering",
        "model_version": MODEL_VERSION,
        "preprocessing_config": {
            "features": request.features,
            "method": request.scaling,
            "missing_values": request.missing_values,
        },
    }

    for name, value in optional_values.items():
        if name in columns and name not in values:
            values[name] = value

    missing_required = [
        name
        for name, column in columns.items()
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

    if missing_required:
        raise RuntimeError(
            "Experiment has additional required fields "
            f"not provided by this service: {sorted(missing_required)}"
        )

    experiment = Experiment(**values)

    db.add(experiment)
    db.flush()

    return experiment


def get_owned_experiment(
    db: Session,
    experiment_id: UUID,
    owner_id: UUID,
) -> Experiment | None:
    """Retrieve an experiment belonging to the specified user."""
    _schema()

    return db.scalar(
        select(Experiment).where(
            Experiment.id == experiment_id,
            Experiment.owner_id == owner_id,
        )
    )


def complete_experiment(
    db: Session,
    experiment_id: UUID,
    result: Mapping[str, Any],
) -> Experiment:
    """Save a completed ML result in the caller's transaction.

    Job status is managed separately by ClusteringJob.
    """
    experiment = db.scalar(
        select(Experiment)
        .where(Experiment.id == experiment_id)
        .with_for_update()
    )

    if experiment is None:
        raise ValueError("Experiment not found")

    if result.get("n_clusters") != experiment.n_clusters:
        raise ValueError(
            "Result cluster count does not match experiment"
        )

    save_completed_result(
        db,
        experiment_id,
        result,
    )

    return experiment
