"""Read-only data quality analysis for a CSV sample."""

from __future__ import annotations

import math
from typing import Any


def _percentile(sorted_values: list[float], proportion: float) -> float:
    position = (len(sorted_values) - 1) * proportion
    lower = int(position)
    upper = min(lower + 1, len(sorted_values) - 1)
    weight = position - lower

    return (
        sorted_values[lower] * (1 - weight)
        + sorted_values[upper] * weight
    )


def _finite_float(value: str) -> float | None:
    try:
        result = float(value)
    except (ValueError, OverflowError):
        return None

    return result if math.isfinite(result) else None


def analyze_sample_quality(
    rows: list[list[str]],
    headers: list[str],
    *,
    total_rows: int | None,
) -> dict[str, Any]:

    if not headers or len(set(headers)) != len(headers):
        raise ValueError("Quality analysis requires unique column names")

    if any(len(row) != len(headers) for row in rows):
        raise ValueError("Quality analysis requires rectangular rows")

    if total_rows is not None and total_rows < len(rows):
        raise ValueError("Total rows cannot be smaller than the sample")

    sample_count = len(rows)

    # Missing-value analysis
    missing_cells = sum(
        not cell.strip()
        for row in rows
        for cell in row
    )

    rows_with_missing = sum(
        any(not cell.strip() for cell in row)
        for row in rows
    )

    # Exact duplicate-row detection
    duplicate_rows = (
        sample_count - len({tuple(row) for row in rows})
    )

    profiles: list[dict[str, Any]] = []

    for col_index, name in enumerate(headers):

        values = [
            row[col_index].strip()
            for row in rows
        ]

        present = [
            value for value in values if value
        ]

        numeric = [
            _finite_float(value)
            for value in present
        ]

        numeric_values = [
            value for value in numeric
            if value is not None
        ]

        invalid_count = len(present) - len(numeric_values)

        # Column type detection
        if not present:
            inferred = "empty"
        elif not numeric_values:
            inferred = "text"
        elif invalid_count:
            inferred = "mixed"
        else:
            inferred = "numeric"

        # Potential outliers using the IQR method
        potential_outliers = 0

        if inferred == "numeric" and len(numeric_values) >= 4:

            ordered = sorted(numeric_values)

            q1 = _percentile(ordered, 0.25)
            q3 = _percentile(ordered, 0.75)

            iqr = q3 - q1

            if math.isfinite(iqr) and iqr > 0:

                lower = q1 - 1.5 * iqr
                upper = q3 + 1.5 * iqr

                potential_outliers = sum(
                    value < lower or value > upper
                    for value in ordered
                )

        profiles.append({
            "name": name,
            "inferred_type": inferred,
            "missing_count": sample_count - len(present),
            "distinct_count": len(set(present)),
            "invalid_numeric_count": (
                invalid_count if inferred == "mixed" else 0
            ),
            "potential_outlier_count": potential_outliers,
            "is_constant": (
                len(present) >= 2
                and len(set(present)) == 1
            ),
        })

    # Dataset-level quality summary
    mixed_count = sum(
        p["inferred_type"] == "mixed"
        for p in profiles
    )

    nonnumeric_count = sum(
        p["inferred_type"] in ("text", "mixed")
        for p in profiles
    )

    empty_count = sum(
        p["inferred_type"] == "empty"
        for p in profiles
    )

    constant_count = sum(
        p["is_constant"]
        for p in profiles
    )

    outlier_count = sum(
        p["potential_outlier_count"]
        for p in profiles
    )

    numeric_count = sum(
        p["inferred_type"] == "numeric"
        for p in profiles
    )

    # Quality recommendations
    recommendations: list[str] = []

    if missing_cells:
        recommendations.append(
            "Review missing values and choose an appropriate "
            "imputation strategy before clustering."
        )

    if duplicate_rows:
        recommendations.append(
            "Inspect duplicate records because they can "
            "influence clustering results."
        )

    if mixed_count:
        recommendations.append(
            "Review columns containing both numeric and text values."
        )

    if nonnumeric_count > mixed_count:
        recommendations.append(
            "K-Means requires numeric features. "
            "Encode or exclude text columns."
        )

    if empty_count:
        recommendations.append(
            "Remove or populate completely empty columns."
        )

    if constant_count:
        recommendations.append(
            "Consider excluding constant columns because "
            "they provide no clustering separation."
        )

    if outlier_count:
        recommendations.append(
            "Inspect potential numeric outliers because "
            "extreme values can affect cluster formation."
        )

    if numeric_count == 0:
        recommendations.append(
            "No fully numeric columns were detected in this sample."
        )

    if not recommendations:
        recommendations.append(
            "No issues detected by these checks. "
            "Review feature relevance before clustering."
        )

    return {
        "sample_scope": "first_rows",
        "sample_is_partial": (
            total_rows is not None
            and total_rows > sample_count
        ),
        "sampled_rows": sample_count,
        "missing_cells": missing_cells,
        "rows_with_missing": rows_with_missing,
        "duplicate_rows": duplicate_rows,
        "nonnumeric_columns": nonnumeric_count,
        "mixed_columns": mixed_count,
        "constant_columns": constant_count,
        "potential_outlier_cells": outlier_count,
        "columns": profiles,
        "recommendations": recommendations,
    }
