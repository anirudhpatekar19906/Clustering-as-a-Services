"""Internal persistence helpers for completed clustering results (File 35).

The parent Experiment must already exist. These helpers deliberately do not
create experiments, alter job statuses, authorize users, or commit sessions.
Call them from a trusted API/worker transaction after verifying ownership.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping
from typing import Any
from uuid import UUID

from sqlalchemy.orm import Session

from backend.models import ExperimentResult
from backend.schemas.experiments import ClusteringResultResponse


def normalize_clustering_result(
    payload: Mapping[str, Any],
) -> dict[str, Any]:
    """Validate and convert an ML result into safe JSON-compatible data.

    In addition to Pydantic's field validation, verify the cross-field
    relationships that make centroids and per-row labels meaningful.
    """
    result = ClusteringResultResponse.model_validate(payload)

    if not 1 <= len(result.model_version) <= 64:
        raise ValueError(
            "model_version must contain 1 to 64 characters"
        )

    k = result.n_clusters
    n = result.n_samples
    d = len(result.features)

    if d == 0 or len(set(result.features)) != d:
        raise ValueError(
            "features must be nonempty and unique"
        )

    if (
        result.metrics.n_samples != n
        or result.metrics.n_clusters != k
    ):
        raise ValueError(
            "metrics dimensions do not match the result"
        )

    if (
        len(result.centroids) != k
        or len(result.scaled_centroids) != k
    ):
        raise ValueError(
            "one centroid per cluster is required"
        )

    if any(
        len(row) != d
        for row in (
            *result.centroids,
            *result.scaled_centroids,
        )
    ):
        raise ValueError(
            "centroids must match the number of features"
        )

    sizes = result.metrics.cluster_sizes

    if (
        set(sizes) != set(range(k))
        or any(count < 1 for count in sizes.values())
    ):
        raise ValueError(
            "cluster sizes must cover every nonempty cluster"
        )

    if sum(sizes.values()) != n:
        raise ValueError(
            "cluster sizes do not add up to n_samples"
        )

    if result.labels is not None:
        if len(result.labels) != n:
            raise ValueError(
                "labels must contain one entry per observation"
            )

        observed = Counter(result.labels)

        if dict(observed) != sizes:
            raise ValueError(
                "labels and reported cluster sizes disagree"
            )

    return result.model_dump(
        mode="json",
        exclude_none=True,
    )


def save_completed_result(
    db: Session,
    experiment_id: UUID,
    payload: Mapping[str, Any],
) -> ExperimentResult:
    """Stage a validated result for an existing experiment.

    The caller commits after all related lifecycle updates succeed.

    Retrying identical results is safe. Different results cannot overwrite
    a previously saved result. The database primary key also protects
    against duplicate inserts from concurrent transactions.
    """
    data = normalize_clustering_result(payload)

    existing = db.get(
        ExperimentResult,
        experiment_id,
    )

    if existing is not None:
        if (
            existing.model_version != data["model_version"]
            or existing.result_json != data
        ):
            raise ValueError(
                "experiment already has a different saved result"
            )

        return existing

    record = ExperimentResult(
        experiment_id=experiment_id,
        model_version=data["model_version"],
        result_json=data,
    )

    db.add(record)
    db.flush()

    return record


def load_completed_result(
    db: Session,
    experiment_id: UUID,
    *,
    include_labels: bool = False,
) -> dict[str, Any] | None:
    """Read a saved result for internal use.

    IMPORTANT: This function does not perform authorization.
    HTTP callers must first verify ownership of the parent experiment.
    """
    record = db.get(
        ExperimentResult,
        experiment_id,
    )

    if record is None:
        return None

    result = normalize_clustering_result(
        record.result_json
    )

    if not include_labels:
        result.pop("labels", None)

    return result
