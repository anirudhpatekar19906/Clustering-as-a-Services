"""Authenticated CSV upload, listing, retrieval, and dataset preview."""

import csv
import hashlib
import logging
import math
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.models import Dataset, User
from backend.routers.auth import get_current_user
from configuration.settings import Settings, get_settings


logger = logging.getLogger("caas.datasets")
router = APIRouter(prefix="/datasets", tags=["Datasets"])

CHUNK_SIZE = 1024 * 1024
PROFILE_SAMPLE_ROWS = 1000
PREVIEW_CELL_CHARS = 200


# --------------------------------------------------
# Response schemas
# --------------------------------------------------

class DatasetUploadResponse(BaseModel):
    """Public dataset metadata, excluding private storage paths."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    original_filename: str
    file_size_bytes: int
    sha256: str
    row_count: int
    column_count: int
    column_names: list[str]
    created_at: datetime


class DatasetListResponse(BaseModel):
    """Paginated dataset listing."""

    items: list[DatasetUploadResponse]
    total: int = Field(ge=0)
    limit: int = Field(ge=1, le=100)
    offset: int = Field(ge=0)


class ColumnProfile(BaseModel):
    """Statistics calculated from sampled CSV rows."""

    name: str
    inferred_type: Literal["integer", "float", "text", "empty"]
    non_missing_count: int
    missing_count: int
    distinct_count: int
    minimum: float | None = None
    maximum: float | None = None
    mean: float | None = None


class DatasetPreviewResponse(BaseModel):
    """Dataset preview and inferred column information."""

    dataset_id: UUID
    total_rows: int | None
    sampled_rows: int
    preview_limit: int
    rows: list[dict[str, str | None]]
    columns: list[ColumnProfile]


# --------------------------------------------------
# Column analysis
# --------------------------------------------------

def _profile_column(name: str, values: list[str]) -> ColumnProfile:
    """Infer a column type and calculate sample-based statistics."""

    present = [value.strip() for value in values if value.strip()]
    missing_count = len(values) - len(present)
    distinct_count = len(set(present))

    if not present:
        inferred_type = "empty"
        numbers: list[float] = []

    else:
        integers_only = all(
            re.fullmatch(r"[+-]?\d+", value)
            for value in present
        )

        numbers = []

        for value in present:
            try:
                number = float(value)
            except (ValueError, OverflowError):
                numbers = []
                break

            if not math.isfinite(number):
                numbers = []
                break

            numbers.append(number)

        inferred_type = (
            "integer" if integers_only else "float"
        ) if len(numbers) == len(present) else "text"

    return ColumnProfile(
        name=name,
        inferred_type=inferred_type,
        non_missing_count=len(present),
        missing_count=missing_count,
        distinct_count=distinct_count,
        minimum=min(numbers) if numbers else None,
        maximum=max(numbers) if numbers else None,
        mean=(
            math.fsum(number / len(numbers) for number in numbers)
            if numbers else None
        ),
    )


def _preview_csv(
    path: Path,
    expected_columns: list[str],
    limit: int,
) -> tuple[list[dict[str, str | None]], int, list[ColumnProfile]]:
    """Read a bounded sample and produce preview rows and column statistics."""

    sampled: list[list[str]] = []

    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.reader(stream, strict=True)

        header = next(reader, None)

        if header != expected_columns:
            raise ValueError(
                "Stored dataset columns do not match its metadata"
            )

        for row in reader:
            if not row:
                continue

            if len(row) != len(expected_columns):
                raise ValueError(
                    "Stored dataset contains an invalid CSV row"
                )

            sampled.append(row)

            if len(sampled) >= PROFILE_SAMPLE_ROWS:
                break

    preview_rows = [
        {
            name: (
                value[:PREVIEW_CELL_CHARS]
                if value.strip()
                else None
            )
            for name, value in zip(expected_columns, row)
        }
        for row in sampled[:limit]
    ]

    columns = [
        _profile_column(
            name,
            [row[index] for row in sampled],
        )
        for index, name in enumerate(expected_columns)
    ]

    return preview_rows, len(sampled), columns


def _safe_dataset_path(root: Path, storage_key: str) -> Path:
    """Ensure stored dataset paths remain inside the upload directory."""

    base = root.resolve()
    target = (base / storage_key).resolve()

    if not target.is_relative_to(base):
        raise HTTPException(
            status_code=500,
            detail="Invalid dataset storage reference",
        )

    return target


# --------------------------------------------------
# CSV upload validation
# --------------------------------------------------

def _inspect_csv(
    path: Path,
    settings: Settings,
) -> tuple[int, list[str]]:
    """Validate CSV headers, encoding, and row and column limits."""

    try:
        with path.open("r", encoding="utf-8-sig", newline="") as stream:
            reader = csv.reader(stream, strict=True)
            header = next(reader, None)

            if not header:
                raise ValueError("CSV must contain a header row")

            if not 2 <= len(header) <= settings.max_dataset_columns:
                raise ValueError(
                    f"CSV must contain 2 to {settings.max_dataset_columns} columns"
                )

            if any(not name.strip() for name in header):
                raise ValueError("CSV column names cannot be blank")

            if len({name.strip().casefold() for name in header}) != len(header):
                raise ValueError("CSV column names must be unique")

            rows = 0

            for row in reader:
                if not row:
                    continue

                if len(row) != len(header):
                    raise ValueError(
                        f"CSV row {reader.line_num} has an incorrect column count"
                    )

                rows += 1

                if rows > settings.max_dataset_rows:
                    raise ValueError(
                        f"CSV exceeds the {settings.max_dataset_rows} row limit"
                    )

            if rows < 2:
                raise ValueError(
                    "CSV must contain at least two data rows"
                )

            return rows, header

    except (UnicodeError, csv.Error) as exc:
        raise ValueError(
            "File must be a valid UTF-8 CSV"
        ) from exc


# --------------------------------------------------
# Upload endpoint
# --------------------------------------------------

@router.post(
    "/upload",
    response_model=DatasetUploadResponse,
    status_code=status.HTTP_201_CREATED,
)
def upload_dataset(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> Dataset:
    """Upload an authenticated user's CSV dataset."""

    filename = (
        (file.filename or "")
        .replace("\\", "/")
        .rsplit("/", 1)[-1]
        .strip()
    )

    if (
        len(filename) > 255
        or filename.lower() == ".csv"
        or not filename.lower().endswith(".csv")
        or any(ord(ch) < 32 for ch in filename)
    ):
        raise HTTPException(
            status_code=415,
            detail="Upload a file with a .csv filename",
        )

    dataset_id = uuid4()
    storage_key = f"{current_user.id}/{dataset_id}.csv"
    destination = settings.upload_dir / storage_key

    destination.parent.mkdir(parents=True, exist_ok=True)

    temp_path: Path | None = None
    saved = False
    committed = False

    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=destination.parent,
            prefix=".upload-",
            suffix=".part",
            delete=False,
        ) as output:
            temp_path = Path(output.name)
            digest = hashlib.sha256()
            size = 0

            while chunk := file.file.read(CHUNK_SIZE):
                size += len(chunk)

                if b"\x00" in chunk:
                    raise HTTPException(
                        status_code=422,
                        detail="CSV must contain UTF-8 text",
                    )

                if size > settings.max_upload_size_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=(
                            f"File exceeds the "
                            f"{settings.max_upload_size_mb} MB upload limit"
                        ),
                    )

                output.write(chunk)
                digest.update(chunk)

        if size == 0:
            raise HTTPException(
                status_code=422,
                detail="CSV file is empty",
            )

        try:
            row_count, columns = _inspect_csv(temp_path, settings)
        except ValueError as exc:
            raise HTTPException(
                status_code=422,
                detail=str(exc),
            ) from exc

        os.replace(temp_path, destination)
        saved = True

        record = Dataset(
            id=dataset_id,
            owner_id=current_user.id,
            original_filename=filename,
            storage_key=storage_key,
            sha256=digest.hexdigest(),
            file_size_bytes=size,
            row_count=row_count,
            column_count=len(columns),
            column_names=columns,
        )

        db.add(record)

        try:
            db.commit()
            committed = True
            db.refresh(record)

        except SQLAlchemyError as exc:
            db.rollback()
            logger.exception("Failed to register uploaded dataset")
            raise HTTPException(
                status_code=500,
                detail="Could not save dataset metadata",
            ) from exc

        return record

    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)

        if saved and not committed:
            destination.unlink(missing_ok=True)


# --------------------------------------------------
# List datasets
# --------------------------------------------------

@router.get("", response_model=DatasetListResponse)
def list_datasets(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DatasetListResponse:
    """Return the authenticated user's datasets with pagination."""

    owner_filter = Dataset.owner_id == current_user.id

    total = db.scalar(
        select(func.count(Dataset.id)).where(owner_filter)
    ) or 0

    records = db.scalars(
        select(Dataset)
        .where(owner_filter)
        .order_by(
            Dataset.created_at.desc(),
            Dataset.id.desc(),
        )
        .offset(offset)
        .limit(limit)
    ).all()

    return DatasetListResponse(
        items=[
            DatasetUploadResponse.model_validate(item)
            for item in records
        ],
        total=total,
        limit=limit,
        offset=offset,
    )


# --------------------------------------------------
# Retrieve dataset metadata
# --------------------------------------------------

@router.get("/{dataset_id}", response_model=DatasetUploadResponse)
def get_dataset(
    dataset_id: UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Dataset:
    """Return metadata only when the dataset belongs to the user."""

    record = db.scalar(
        select(Dataset).where(
            Dataset.id == dataset_id,
            Dataset.owner_id == current_user.id,
        )
    )

    if record is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Dataset not found",
        )

    return record


# --------------------------------------------------
# Dataset preview and column analysis
# --------------------------------------------------

@router.get(
    "/{dataset_id}/preview",
    response_model=DatasetPreviewResponse,
)
def preview_dataset(
    dataset_id: UUID,
    limit: int = Query(default=5, ge=1, le=50),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> DatasetPreviewResponse:
    """Preview an owned CSV using a bounded sample of up to 1,000 rows."""

    record = get_dataset(
        dataset_id,
        current_user=current_user,
        db=db,
    )

    path = _safe_dataset_path(
        settings.upload_dir,
        record.storage_key,
    )

    try:
        preview_rows, sample_count, columns = _preview_csv(
            path,
            record.column_names or [],
            limit,
        )

    except FileNotFoundError as exc:
        logger.warning(
            "Dataset file missing (dataset_id=%s)",
            dataset_id,
        )
        raise HTTPException(
            status_code=404,
            detail="Dataset file unavailable",
        ) from exc

    except (UnicodeError, csv.Error, ValueError) as exc:
        logger.error(
            "Stored CSV cannot be previewed (dataset_id=%s): %s",
            dataset_id,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=409,
            detail="Stored dataset cannot be previewed",
        ) from exc

    except OSError as exc:
        logger.exception(
            "Dataset preview storage error (dataset_id=%s)",
            dataset_id,
        )
        raise HTTPException(
            status_code=503,
            detail="Dataset storage temporarily unavailable",
        ) from exc

    return DatasetPreviewResponse(
        dataset_id=record.id,
        total_rows=record.row_count,
        sampled_rows=sample_count,
        preview_limit=limit,
        rows=preview_rows,
        columns=columns,
    )
