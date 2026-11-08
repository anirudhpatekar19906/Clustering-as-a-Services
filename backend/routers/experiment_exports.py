
"""File 99 — secure CSV export of completed, saved clustering experiments.

Defines GET /api/v1/experiments/history/{experiment_id}/export.csv.

The route is not active until its router is registered in backend/main.py
(File 100). The registered URL inherits the /api/v1 prefix from main.py.

Security: both the experiment and its dataset must belong to the caller;
source CSV bytes must match the upload's saved SHA-256 and file size;
every label must align with the original parsed row index. No client-provided
file paths or cluster assignments are accepted.
"""

from __future__ import annotations

import csv
import io
import logging
import re
from pathlib import Path
from tempfile import SpooledTemporaryFile
from typing import BinaryIO, Iterator
from uuid import UUID

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.experiment_lifecycle import get_owned_experiment
from backend.experiment_store import load_completed_result
from backend.models import Dataset, User
from backend.routers.auth import get_current_user
from backend.routers.experiment_plots import _verified_csv_path

logger = logging.getLogger("caas.experiment_exports")
router = APIRouter(prefix="/experiments", tags=["Experiments"])

CSV_CHUNK_ROWS = 2_500
STREAM_CHUNK_BYTES = 64 * 1024
SPOOL_MEMORY_BYTES = 8 * 1024 * 1024

SIGNED_NUMBER = re.compile(
    r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\Z"
)


def _spreadsheet_safe(value: object) -> str:
    """Neutralize spreadsheet formula injection in untrusted CSV cells.

    Numeric values such as -42 or +3.5 remain numeric. Other cells starting
    with =, +, -, @, or control whitespace are prefixed with an apostrophe.
    This intentionally alters suspicious text values for spreadsheet safety.
    """
    if value is None or pd.isna(value):
        return ""

    text = str(value)
    stripped = text.lstrip(" \t\r\n")

    if not stripped:
        return text

    if text[0] in "\t\r\n":
        return "'" + text

    if stripped[0] in "=@":
        return "'" + text

    if (
        stripped[0] in "+-"
        and SIGNED_NUMBER.fullmatch(stripped) is None
    ):
        return "'" + text

    return text


def _cluster_column(headers: list[str]) -> str:
    """Never overwrite an uploaded column named cluster."""
    if "cluster" not in headers:
        return "cluster"

    if "caas_cluster" not in headers:
        return "caas_cluster"

    suffix = 2

    while f"caas_cluster_{suffix}" in headers:
        suffix += 1

    return f"caas_cluster_{suffix}"


def _prepare_csv(
    source: Path,
    *,
    columns: list[str],
    expected_rows: int,
    labels: list[int],
) -> BinaryIO:
    """Build a bounded-memory temporary CSV, validating all rows first.

    Pandas parsing options match the worker's row ordering. Reading columns
    as strings prevents CSV values like '00123' becoming 123 in the export.
    Writing to a spooled temporary file avoids building one huge CSV string.
    The file is returned positioned at byte zero; the caller must close it.
    """
    output: BinaryIO = SpooledTemporaryFile(
        max_size=SPOOL_MEMORY_BYTES,
        mode="w+b",
    )

    written = 0

    try:
        # UTF-8 BOM for spreadsheet compatibility.
        output.write(b"\xef\xbb\xbf")

        buffer = io.StringIO(newline="")
        writer = csv.writer(
            buffer,
            lineterminator="\r\n",
        )

        writer.writerow(
            [_spreadsheet_safe(name) for name in columns]
            + [_cluster_column(columns)]
        )

        output.write(
            buffer.getvalue().encode("utf-8")
        )

        buffer.seek(0)
        buffer.truncate(0)

        with pd.read_csv(
            source,
            encoding="utf-8-sig",
            low_memory=False,
            on_bad_lines="error",
            dtype=str,
            keep_default_na=False,
            na_filter=False,
            chunksize=CSV_CHUNK_ROWS,
        ) as reader:

            for frame in reader:
                if list(frame.columns) != columns:
                    raise ValueError(
                        "Source CSV columns differ from upload metadata"
                    )

                if written + len(frame) > expected_rows:
                    raise ValueError(
                        "Source CSV contains more rows than the saved result"
                    )

                for row in frame.itertuples(
                    index=False,
                    name=None,
                ):
                    writer.writerow(
                        [_spreadsheet_safe(cell) for cell in row]
                        + [labels[written]]
                    )

                    written += 1

                output.write(
                    buffer.getvalue().encode("utf-8")
                )

                buffer.seek(0)
                buffer.truncate(0)

        if written != expected_rows:
            raise ValueError(
                "Source CSV row count differs from the saved result"
            )

        output.seek(0)
        return output

    except Exception:
        output.close()
        raise


def _stream_file(stream: BinaryIO) -> Iterator[bytes]:
    """Always close the temporary file after download or disconnection."""
    try:
        while chunk := stream.read(STREAM_CHUNK_BYTES):
            yield chunk

    finally:
        stream.close()


@router.get(
    "/history/{experiment_id}/export.csv",
    summary="Download the original dataset with saved cluster assignments",
    response_class=StreamingResponse,
)
def export_completed_experiment_csv(
    experiment_id: UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    """Export all original parsed rows, not a visualization sample.

    The result must be permanently saved and must contain full per-row labels.
    Another user's experiment and dataset both appear as 404. Private output
    is never stored in a shared static directory or cache.
    """

    # 1. Verify experiment ownership.
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

    # 2. Verify ownership of the associated dataset.
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

    # 3. Read permanent clustering results with all labels.
    try:
        saved = load_completed_result(
            db,
            experiment_id,
            include_labels=True,
        )

    except (ValueError, TypeError, ValidationError) as exc:
        logger.warning(
            "Invalid saved clustering result for %s",
            experiment_id,
        )
        raise HTTPException(
            status_code=502,
            detail="Saved result is unavailable",
        ) from exc

    if saved is None:
        raise HTTPException(
            status_code=409,
            detail="This experiment has no saved result yet",
        )

    labels = saved.get("labels")
    rows = saved.get("n_samples")
    count = saved.get("n_clusters")
    columns = dataset.column_names

    # 4. Prevent mismatched or corrupted row assignments.
    if (
        not isinstance(rows, int)
        or rows < 2
        or rows != dataset.row_count
        or not isinstance(count, int)
        or count < 2
        or not isinstance(labels, list)
        or len(labels) != rows
        or any(
            type(label) is not int
            or not 0 <= label < count
            for label in labels
        )
        or not isinstance(columns, list)
        or not columns
        or any(
            not isinstance(name, str)
            for name in columns
        )
    ):
        raise HTTPException(
            status_code=409,
            detail="Saved labels cannot be aligned to CSV rows",
        )

    # 5. Reuse our existing SHA-256 and path-containment checks.
    source = _verified_csv_path(dataset)

    # 6. Create the downloadable CSV.
    try:
        output = _prepare_csv(
            source,
            columns=columns,
            expected_rows=rows,
            labels=labels,
        )

    except (
        OSError,
        UnicodeError,
        ValueError,
        csv.Error,
        pd.errors.ParserError,
        pd.errors.EmptyDataError,
    ) as exc:
        logger.warning(
            "Unable to prepare CSV export for %s: %s",
            experiment_id,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=502,
            detail="CSV export could not be prepared",
        ) from exc

    filename = f"caas-clusters-{experiment_id}.csv"

    # 7. Return a private, downloadable CSV response.
    return StreamingResponse(
        _stream_file(output),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{filename}"'
            ),
            "Cache-Control": "private, no-store, max-age=0",
            "Vary": "Authorization",
            "X-Content-Type-Options": "nosniff",
            "X-Robots-Tag": "noindex",
        },
    )
