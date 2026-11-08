"""From-scratch numeric preprocessing for the clustering engine.

Only NumPy and Pandas perform data operations. No fitted preprocessing
transformer or statistical helper from a machine-learning package is used.
"""

from dataclasses import dataclass
from typing import Literal, Sequence

import numpy as np
import pandas as pd
from numpy.typing import NDArray


ScaleMethod = Literal["none", "standardize", "minmax"]
MissingMethod = Literal["error", "median", "mean", "zero"]


@dataclass(frozen=True)
class PreprocessingConfig:
    """Configuration saved alongside a clustering experiment."""

    features: Sequence[str] | None = None
    method: ScaleMethod = "standardize"
    missing_values: MissingMethod = "median"


@dataclass(frozen=True)
class PreprocessingResult:
    """Clustering-ready matrix plus reproducibility metadata."""

    values: NDArray[np.float64]
    feature_names: tuple[str, ...]
    means: tuple[float, ...] | None
    scales: tuple[float, ...] | None
    imputation_values: tuple[float, ...] | None
    minima: tuple[float, ...] | None
    method: ScaleMethod
    missing_values: MissingMethod


class NumericPreprocessor:
    """Learn numeric imputation/scaling once and reuse it on new observations.

    fit(X) learns imputation and scaling statistics from X.
    transform(X) uses those SAME statistics without refitting.
    """

    def __init__(self, config: PreprocessingConfig | None = None) -> None:
        self.config = config if config is not None else PreprocessingConfig()
        if self.config.method not in ("none", "standardize", "minmax"):
            raise ValueError("method must be 'none', 'standardize', or 'minmax'")
        if self.config.missing_values not in ("error", "median", "mean", "zero"):
            raise ValueError("missing_values must be 'error', 'median', 'mean', or 'zero'")

        self.feature_names_: tuple[str, ...] | None = None
        self.imputation_values_: NDArray[np.float64] | None = None
        self.offsets_: NDArray[np.float64] | None = None
        self.scales_: NDArray[np.float64] | None = None
        self.n_samples_fit_: int | None = None

    @staticmethod
    def _validate_frame(frame: pd.DataFrame, *, min_rows: int) -> None:
        if not isinstance(frame, pd.DataFrame):
            raise TypeError("dataset must be a pandas DataFrame")
        if len(frame) < min_rows:
            raise ValueError(f"dataset must contain at least {min_rows} row(s)")
        if not frame.columns.is_unique:
            raise ValueError("dataset column names must be unique")
        if any(not isinstance(column, str) or not column.strip() for column in frame.columns):
            raise ValueError("dataset columns must have nonempty string names")

    def _choose_features(self, frame: pd.DataFrame) -> tuple[str, ...]:
        if self.config.features is None:
            # Numeric-looking string columns can be selected explicitly.
            names = tuple(
                name for name in frame.columns
                if pd.api.types.is_numeric_dtype(frame[name])
                and not pd.api.types.is_bool_dtype(frame[name])
            )
        else:
            names = tuple(self.config.features)

        if not names or any(not isinstance(name, str) or not name.strip() for name in names):
            raise ValueError("at least one valid numeric feature name is required")
        if len(names) != len(set(names)):
            raise ValueError("selected feature names must be unique")
        self._require_features(frame, names)
        return names

    @staticmethod
    def _require_features(frame: pd.DataFrame, names: tuple[str, ...]) -> None:
        missing = [name for name in names if name not in frame.columns]
        if missing:
            raise ValueError(f"feature columns not found: {missing}")

    @staticmethod
    def _numeric_matrix(frame: pd.DataFrame, names: tuple[str, ...]) -> NDArray[np.float64]:
        columns = []
        for name in names:
            source = frame[name]
            if pd.api.types.is_object_dtype(source) or pd.api.types.is_string_dtype(source):
                # Whitespace-only cells are missing; nonnumeric text is invalid.
                source = source.map(
                    lambda value: (value.strip() or np.nan)
                    if isinstance(value, str) else value
                )
            converted = pd.to_numeric(source, errors="coerce")
            invalid = source.notna() & converted.isna()
            if bool(invalid.any()):
                raise ValueError(f"feature '{name}' contains non-numeric values")
            try:
                numeric = converted.to_numpy(dtype=np.float64, na_value=np.nan)
            except (TypeError, ValueError, OverflowError) as exc:
                raise ValueError(f"feature '{name}' cannot be converted to float") from exc
            if np.isinf(numeric).any():
                raise ValueError(f"feature '{name}' contains infinity or an oversized value")
            columns.append(numeric)

        return np.column_stack(columns)

    def _fill_missing(self, matrix: NDArray[np.float64]) -> NDArray[np.float64]:
        result = matrix.copy()
        if np.isnan(result).any():
            if self.config.missing_values == "error":
                raise ValueError("feature values contain missing data")
            if self.imputation_values_ is None:
                raise RuntimeError("preprocessor is not fitted")
            rows, cols = np.where(np.isnan(result))
            result[rows, cols] = self.imputation_values_[cols]
        return result

    def fit(self, frame: pd.DataFrame) -> "NumericPreprocessor":
        """Learn per-feature imputation values and scaling parameters."""
        self._validate_frame(frame, min_rows=2)
        names = self._choose_features(frame)
        matrix = self._numeric_matrix(frame, names)

        if np.isnan(matrix).all(axis=0).any():
            raise ValueError("a selected feature contains only missing values")

        if self.config.missing_values == "median":
            fills = np.nanmedian(matrix, axis=0)
        elif self.config.missing_values == "mean":
            fills = np.nanmean(matrix, axis=0)
        elif self.config.missing_values == "zero":
            fills = np.zeros(matrix.shape[1], dtype=np.float64)
        else:
            fills = np.zeros(matrix.shape[1], dtype=np.float64)
            if np.isnan(matrix).any():
                raise ValueError("feature values contain missing data")

        if not np.isfinite(fills).all():
            raise ValueError("imputation values are not finite")

        filled = matrix.copy()
        rows, cols = np.where(np.isnan(filled))
        filled[rows, cols] = fills[cols]

        if self.config.method == "standardize":
            offsets = filled.mean(axis=0)
            scales = filled.std(axis=0, ddof=0)
        elif self.config.method == "minmax":
            offsets = filled.min(axis=0)
            scales = filled.max(axis=0) - offsets
        else:
            offsets = np.zeros(filled.shape[1], dtype=np.float64)
            scales = np.ones(filled.shape[1], dtype=np.float64)

        if not np.isfinite(offsets).all() or not np.isfinite(scales).all():
            raise ValueError("scaling parameters are not finite")
        scales = np.where(scales == 0.0, 1.0, scales)

        self.feature_names_ = names
        self.imputation_values_ = fills.astype(np.float64, copy=True)
        self.offsets_ = offsets.astype(np.float64, copy=True)
        self.scales_ = scales.astype(np.float64, copy=True)
        self.n_samples_fit_ = len(frame)
        return self

    def transform(self, frame: pd.DataFrame) -> NDArray[np.float64]:
        """Transform rows using the statistics learned by fit()."""
        if self.feature_names_ is None or self.offsets_ is None or self.scales_ is None:
            raise RuntimeError("call fit() before transform()")
        self._validate_frame(frame, min_rows=1)
        self._require_features(frame, self.feature_names_)
        matrix = self._numeric_matrix(frame, self.feature_names_)
        matrix = self._fill_missing(matrix)
        transformed = (matrix - self.offsets_) / self.scales_
        if not np.isfinite(transformed).all():
            raise ValueError("preprocessing produced non-finite values")
        return transformed

    def fit_transform(self, frame: pd.DataFrame) -> NDArray[np.float64]:
        """Fit and transform training observations."""
        return self.fit(frame).transform(frame)

    def get_metadata(self) -> dict[str, object]:
        """Return JSON-serializable metadata for experiment reproducibility."""
        if (self.feature_names_ is None or self.imputation_values_ is None
                or self.offsets_ is None or self.scales_ is None):
            raise RuntimeError("call fit() before get_metadata()")
        return {
            "features": list(self.feature_names_),
            "method": self.config.method,
            "missing_values": self.config.missing_values,
            "imputation_values": self.imputation_values_.tolist(),
            "offsets": self.offsets_.tolist(),
            "scales": self.scales_.tolist(),
            "n_samples_fit": self.n_samples_fit_,
        }


def preprocess_dataset(
    dataset: pd.DataFrame,
    options: PreprocessingConfig | None = None,
) -> PreprocessingResult:
    """One-shot API compatible with the original project service layer."""
    processor = NumericPreprocessor(options)
    values = processor.fit_transform(dataset)
    assert processor.feature_names_ is not None
    assert processor.offsets_ is not None
    assert processor.scales_ is not None
    assert processor.imputation_values_ is not None
    method = processor.config.method
    return PreprocessingResult(
        values=values,
        feature_names=processor.feature_names_,
        means=tuple(processor.offsets_.tolist()) if method == "standardize" else None,
        scales=tuple(processor.scales_.tolist()) if method != "none" else None,
        imputation_values=(tuple(processor.imputation_values_.tolist())
                           if processor.config.missing_values != "error" else None),
        minima=tuple(processor.offsets_.tolist()) if method == "minmax" else None,
        method=method,
        missing_values=processor.config.missing_values,
    )
