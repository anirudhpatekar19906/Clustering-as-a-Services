"""File 87 — Owner-scoped pagination over *saved* clustering results.

New endpoint, once this router is included in backend/main.py:
    GET /api/v1/saved-results?limit=20&offset=0

Unlike /experiments/history, both the count and the page are filtered to
experiments that have a durable ExperimentResult row. Only metadata is read;
cluster labels and the potentially large result_json are not loaded.

File 87 defines the router; File 88 will register it with the FastAPI app.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.models import Experiment, ExperimentResult, User
from backend.routers.auth import get_current_user
from backend.routers.experiments import (
    ExperimentHistoryItemResponse,
    ExperimentHistoryListResponse,
)

logger = logging.getLogger("caas.saved_results")

router = APIRouter(
    prefix="/saved-results",
    tags=["Experiments"],
)


@router.get(
    "",
    response_model=ExperimentHistoryListResponse,
    status_code=status.HTTP_200_OK,
    summary="List only the current user's completed, saved analyses",
    description=(
        "Paginates experiments with an existing persisted result. "
        "The total counts saved results only, not all experiments. "
        "Does not return cluster labels or stored result JSON."
    ),
)
def list_saved_results(
    response: Response,
    limit: int = Query(
        default=20,
        ge=1,
        le=100,
    ),
    offset: int = Query(
        default=0,
        ge=0,
    ),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ExperimentHistoryListResponse:
    """Paginate only saved analyses belonging to the signed-in user.

    The ExperimentResult primary key is experiment_id, so the inner join
    cannot produce multiple rows for a single experiment.

    Use the same owner-filtered join for the COUNT and page query.
    Never paginate all experiments first and filter in Python.
    """

    # Protect private responses from being cached by intermediaries.
    response.headers["Cache-Control"] = (
        "private, no-store, max-age=0"
    )
    response.headers["Vary"] = "Authorization"
    response.headers["X-Content-Type-Options"] = "nosniff"

    # The user's identity comes from the verified JWT.
    owner_filter = (
        Experiment.owner_id == current_user.id
    )

    try:
        # Count only experiments that have a stored result.
        total = db.scalar(
            select(
                func.count(Experiment.id)
            )
            .select_from(Experiment)
            .join(
                ExperimentResult,
                ExperimentResult.experiment_id == Experiment.id,
            )
            .where(owner_filter)
        ) or 0

        # Retrieve only saved-result metadata, in stable order.
        # Do not load the result_json column or cluster labels.
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
            )
            .select_from(Experiment)
            .join(
                ExperimentResult,
                ExperimentResult.experiment_id == Experiment.id,
            )
            .where(owner_filter)
            .order_by(
                Experiment.created_at.desc(),
                Experiment.id.desc(),
            )
            .offset(offset)
            .limit(limit)
        ).all()

    except SQLAlchemyError as exc:
        logger.exception(
            "Unable to list saved clustering results"
        )

        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Saved results are temporarily unavailable",
        ) from exc

    # Reuse the already-tested experiment history response schema.
    # Every entry in this query has an actual ExperimentResult row.
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
                result_available=True,
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
            ) in rows
        ],
        total=total,
        limit=limit,
        offset=offset,
    )
