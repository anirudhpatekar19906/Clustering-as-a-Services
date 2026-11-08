"""File 79 — Authenticated, row-aligned scatter data for saved experiments.

This router is intentionally separate from the existing experiments router:
register it in backend/main.py in the next file, without replacing tested code.

GET /api/v1/experiments/history/{experiment_id}/plot-data

The endpoint joins saved labels with *verified original CSV rows by row index*.
It samples at most 1,500 finite (x, y) rows, never invents points, and never
returns other columns. Original missing/non-numeric coordinates are omitted,
not silently replaced by imputed values from preprocessing.
"""

from __future__ import annotations

import hashlib
import logging
import math
from pathlib import Path
from typing import Literal
from uuid import UUID

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.experiment_lifecycle import get_owned_experiment
from backend.experiment_store import load_completed_result
from backend.models import Dataset, User
from backend.routers.auth import get_current_user
from configuration.settings import get_settings

logger = logging.getLogger("caas.experiment_plots")
router = APIRouter(prefix="/experiments", tags=["Experiments"])

MAX_PLOT_POINTS = 1_500
FILE_READ_BYTES = 1024 * 1024


class ScatterPoint(BaseModel):
    """A real uploaded CSV row with its permanently saved cluster label."""

    model_config = ConfigDict(extra="forbid")

    row_index: int = Field(
        ge=0,
        description="Zero-based original CSV data-row index",
    )
    x: float
    y: float
    cluster: int = Field(ge=0)


class ScatterDataResponse(BaseModel):
    """A bounded, owner-verified 2D view of a completed experiment."""

    model_config = ConfigDict(extra="forbid")

    experiment_id: UUID
    dataset_id: UUID
    x_feature: str
    y_feature: str

    coordinate_space: Literal["original_csv"] = "original_csv"
    selection: Literal[
        "evenly_spaced_valid_rows"
    ] = "evenly_spaced_valid_rows"

    total_rows: int = Field(ge=2)
    eligible_rows: int = Field(ge=0)
    omitted_invalid_rows: int = Field(ge=0)
    returned_points: int = Field(
        ge=0,
        le=MAX_PLOT_POINTS,
    )

    sampled: bool
    n_clusters: int = Field(ge=2)
    points: list[ScatterPoint]


def _verified_csv_path(record: Dataset) -> Path:
    """Verify the stored CSV is unchanged before joining labels.

    The clustering worker verifies this hash as well.
    Rechecking it prevents later file changes from silently
    misaligning the saved cluster assignments.
    """
    root = Path(get_settings().upload_dir).resolve()

    storage_key = record.storage_key

    if (
        not isinstance(storage_key, str)
        or not storage_key
    ):
        raise HTTPException(
            status_code=503,
            detail="Dataset file is unavailable",
        )

    target = (root / storage_key).resolve()

    if (
        not target.is_relative_to(root)
        or not target.is_file()
    ):
        raise HTTPException(
            status_code=503,
            detail="Dataset file is unavailable",
        )

    expected_size = record.file_size_bytes
    expected_hash = record.sha256

    if (
        not isinstance(expected_size, int)
        or expected_size < 0
        or not isinstance(expected_hash, str)
        or len(expected_hash) != 64
    ):
        raise HTTPException(
            status_code=502,
            detail="Dataset integrity metadata is unavailable",
        )

    digest = hashlib.sha256()
    actual_size = 0

    try:
        with target.open("rb") as stream:
            while chunk := stream.read(FILE_READ_BYTES):
                actual_size += len(chunk)
                digest.update(chunk)

    except OSError as exc:
        logger.warning(
            "Unable to read stored dataset %s: %s",
            record.id,
            type(exc).__name__,
        )

        raise HTTPException(
            status_code=503,
            detail="Dataset file is unavailable",
        ) from exc

    if (
        actual_size != expected_size
        or digest.hexdigest() != expected_hash.lower()
    ):
        logger.error(
            "Stored CSV integrity check failed for dataset %s",
            record.id,
        )

        raise HTTPException(
            status_code=409,
            detail=(
                "Stored dataset has changed; "
                "plot data cannot be trusted"
            ),
        )

    return target


def _evenly_spaced_indices(
    eligible: list[int],
    maximum: int,
) -> list[int]:
    """Sample across valid rows, preserving their original order."""

    if len(eligible) <= maximum:
        return eligible

    if maximum == 1:
        return [eligible[0]]

    last = len(eligible) - 1

    return [
        eligible[
            (i * last) // (maximum - 1)
        ]
        for i in range(maximum)
    ]


def _read_original_coordinates(
    csv_path: Path,
    *,
    x_feature: str,
    y_feature: str,
    expected_rows: int,
) -> tuple[list[float], list[float]]:
    """Read the same original row ordering used by the worker.

    Missing and non-numeric values become NaN and will be excluded.
    These values are not silently replaced by imputed training values.
    """
    try:
        frame = pd.read_csv(
            csv_path,
            encoding="utf-8-sig",
            low_memory=False,
            on_bad_lines="error",
            usecols=[
                x_feature,
                y_feature,
            ],
        )

        if len(frame) != expected_rows:
            raise ValueError(
                "CSV row count differs from completed experiment"
            )

        x = pd.to_numeric(
            frame[x_feature],
            errors="coerce",
        )

        y = pd.to_numeric(
            frame[y_feature],
            errors="coerce",
        )

        return (
            x.to_numpy(
                dtype="float64",
                na_value=float("nan"),
            ).tolist(),
            y.to_numpy(
                dtype="float64",
                na_value=float("nan"),
            ).tolist(),
        )

    except (
        OSError,
        ValueError,
        UnicodeError,
        pd.errors.ParserError,
        pd.errors.EmptyDataError,
    ) as exc:
        logger.warning(
            "Stored CSV cannot be used for scatter coordinates: %s",
            type(exc).__name__,
        )

        raise HTTPException(
            status_code=502,
            detail="Dataset coordinates are unavailable",
        ) from exc


@router.get(
    "/history/{experiment_id}/plot-data",
    response_model=ScatterDataResponse,
    summary=(
        "Get verified original-row scatter points "
        "with saved cluster labels"
    ),
)
def get_experiment_plot_data(
    experiment_id: UUID,
    response: Response,

    x_feature: str | None = Query(
        default=None,
        min_length=1,
        max_length=128,
    ),

    y_feature: str | None = Query(
        default=None,
        min_length=1,
        max_length=128,
    ),

    max_points: int = Query(
        default=1_000,
        ge=2,
        le=MAX_PLOT_POINTS,
    ),

    current_user: User = Depends(
        get_current_user
    ),

    db: Session = Depends(
        get_db
    ),
) -> ScatterDataResponse:
    """Return real row coordinates paired with saved cluster labels."""

    response.headers[
        "Cache-Control"
    ] = "private, no-store, max-age=0"

    response.headers[
        "X-Content-Type-Options"
    ] = "nosniff"

    # Step 1: Verify experiment ownership.
    experiment = get_owned_experiment(
        db,
        experiment_id,
        current_user.id,
    )

    if experiment is None:
        raise HTTPException(
            status_code=404,
            detail="Experiment not found",
        )

    # Step 2: Verify the related dataset is owned by the same user.
    dataset = db.scalar(
        select(Dataset).where(
            Dataset.id == experiment.dataset_id,
            Dataset.owner_id == current_user.id,
        )
    )

    if dataset is None:
        raise HTTPException(
            status_code=404,
            detail="Experiment not found",
        )

    # Step 3: Load the completed saved labels from PostgreSQL.
    try:
        stored = load_completed_result(
            db,
            experiment_id,
            include_labels=True,
        )

    except (ValueError, TypeError) as exc:
        logger.exception(
            "Invalid saved clustering result for %s",
            experiment_id,
        )

        raise HTTPException(
            status_code=502,
            detail="Saved clustering result is invalid",
        ) from exc

    if stored is None:
        raise HTTPException(
            status_code=409,
            detail="This experiment has no saved result yet",
        )

    features = stored.get("features")
    labels = stored.get("labels")
    total = stored.get("n_samples")
    n_clusters = stored.get("n_clusters")

    if (
        not isinstance(features, list)
        or not all(
            isinstance(feature, str)
            for feature in features
        )
        or len(features) < 2
        or not isinstance(total, int)
        or total < 2
        or total != dataset.row_count
        or not isinstance(n_clusters, int)
        or n_clusters < 2
        or not isinstance(labels, list)
        or len(labels) != total
        or any(
            type(label) is not int
            or label < 0
            or label >= n_clusters
            for label in labels
        )
    ):
        raise HTTPException(
            status_code=409,
            detail=(
                "Saved result cannot be aligned to CSV rows"
            ),
        )

    # Step 4: Choose only features used by this experiment.
    chosen_x = (
        x_feature
        if x_feature is not None
        else features[0]
    )

    chosen_y = (
        y_feature
        if y_feature is not None
        else features[1]
    )

    if (
        chosen_x == chosen_y
        or chosen_x not in features
        or chosen_y not in features
    ):
        raise HTTPException(
            status_code=422,
            detail=(
                "Select two distinct feature names "
                "used in this experiment"
            ),
        )

    # Step 5: Check the original CSV integrity.
    csv_path = _verified_csv_path(
        dataset
    )

    # Step 6: Read original X and Y values in CSV row order.
    x_coordinates, y_coordinates = (
        _read_original_coordinates(
            csv_path,
            x_feature=chosen_x,
            y_feature=chosen_y,
            expected_rows=total,
        )
    )

    # Step 7: Exclude rows without valid original coordinates.
    eligible = [
        index
        for index, (x, y) in enumerate(
            zip(
                x_coordinates,
                y_coordinates,
            )
        )
        if math.isfinite(x)
        and math.isfinite(y)
    ]

    # Step 8: Limit returned points for responsive charts.
    selected = _evenly_spaced_indices(
        eligible,
        max_points,
    )

    # Step 9: Pair row i with its saved cluster label at index i.
    points = [
        ScatterPoint(
            row_index=index,
            x=x_coordinates[index],
            y=y_coordinates[index],
            cluster=labels[index],
        )
        for index in selected
    ]

    return ScatterDataResponse(
        experiment_id=experiment.id,
        dataset_id=dataset.id,
        x_feature=chosen_x,
        y_feature=chosen_y,
        total_rows=total,
        eligible_rows=len(eligible),
        omitted_invalid_rows=(
            total - len(eligible)
        ),
        returned_points=len(points),
        sampled=(
            len(eligible) > len(points)
        ),
        n_clusters=n_clusters,
        points=points,
    )
