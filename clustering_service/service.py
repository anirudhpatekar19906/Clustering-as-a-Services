"""Orchestrate numeric preprocessing, custom K-Means, and evaluation.

This module operates on in-memory pandas DataFrames. File access,
authentication, database persistence, and background jobs belong to the
API/worker layers, not to the clustering engine.
"""

from __future__ import annotations

from dataclasses import dataclass
from time import perf_counter
from typing import Literal, Sequence

import numpy as np
import pandas as pd
from numpy.typing import NDArray

from clustering_service.kmeans import KMeansFromScratch
from clustering_service.metrics import ClusteringMetrics, evaluate_clustering
from clustering_service.preprocessing import (
    MissingMethod,
    NumericPreprocessor,
    PreprocessingConfig,
    ScaleMethod,
)

MODEL_VERSION = "kmeans-v1"


@dataclass(frozen=True)
class ClusteringConfig:
    """User-selected options for one reproducible clustering run."""

    n_clusters: int
    features: Sequence[str] | None = None
    scaling: ScaleMethod = "standardize"
    missing_values: MissingMethod = "median"
    init: Literal["kmeans++", "random"] = "kmeans++"
    max_iter: int = 300
    tolerance: float = 1e-4
    n_init: int = 3
    random_state: int = 42
    include_silhouette: bool = True
    silhouette_sample_size: int = 1500


@dataclass(frozen=True)
class ClusteringResult:
    """Completed run, with arrays for workers and JSON-ready summary data.

    centroids are in original feature units; scaled_centroids are in the
    transformed feature space where K-Means and SSE are calculated.
    Labels preserve the order of the input DataFrame rows.
    """

    labels: NDArray[np.int64]
    centroids: NDArray[np.float64]
    scaled_centroids: NDArray[np.float64]
    feature_names: tuple[str, ...]
    metrics: ClusteringMetrics
    preprocessing_metadata: dict[str, object]
    algorithm_config: dict[str, object]
    iterations: int
    converged: bool
    processing_time_ms: float

    def to_dict(self, *, include_labels: bool = False) -> dict[str, object]:
        """Return a JSON-serializable summary; omit large labels by default."""

        summary: dict[str, object] = {
            "algorithm": "custom_kmeans",
            "model_version": MODEL_VERSION,
            "n_samples": self.metrics.n_samples,
            "n_clusters": self.metrics.n_clusters,
            "features": list(self.feature_names),
            "centroids": self.centroids.tolist(),
            "scaled_centroids": self.scaled_centroids.tolist(),
            "metrics": self.metrics.to_dict(),
            "preprocessing_config": self.preprocessing_metadata,
            "algorithm_config": self.algorithm_config,
            "iterations": self.iterations,
            "converged": self.converged,
            "processing_time_ms": self.processing_time_ms,
        }
        if include_labels:
            summary["labels"] = self.labels.tolist()
        return summary


def run_clustering(
    dataset: pd.DataFrame,
    config: ClusteringConfig,
) -> ClusteringResult:
    """Fit the complete from-scratch K-Means pipeline for a DataFrame.

    Raises ValueError for invalid configuration or dataset content.
    Does not mutate the caller's DataFrame or write any files or DB records.
    """

    if not isinstance(config, ClusteringConfig):
        raise TypeError("config must be a ClusteringConfig instance")

    # Validate K-Means options before doing potentially expensive preparation.
    model = KMeansFromScratch(
        n_clusters=config.n_clusters,
        init=config.init,
        max_iter=config.max_iter,
        tolerance=config.tolerance,
        n_init=config.n_init,
        random_state=config.random_state,
    )
    if model.n_clusters < 2:
        raise ValueError("at least two clusters are required for an experiment")
    if not isinstance(config.include_silhouette, bool):
        raise ValueError("include_silhouette must be a boolean")

    start = perf_counter()
    preprocessor = NumericPreprocessor(
        PreprocessingConfig(
            features=config.features,
            method=config.scaling,
            missing_values=config.missing_values,
        )
    )
    matrix = preprocessor.fit_transform(dataset)
    model.fit(matrix)

    # fit() supplies these attributes on success.
    assert model.labels_ is not None
    assert model.centroids_ is not None
    assert preprocessor.offsets_ is not None
    assert preprocessor.scales_ is not None
    assert preprocessor.feature_names_ is not None

    metrics = evaluate_clustering(
        matrix,
        model.labels_,
        model.centroids_,
        include_silhouette=config.include_silhouette,
        silhouette_sample_size=config.silhouette_sample_size,
        random_state=config.random_state,
    )

    # Undo min-max/standard scaling for meaningful displayed centroid values.
    centroids = (
        model.centroids_ * preprocessor.scales_ + preprocessor.offsets_
    )
    if not np.isfinite(centroids).all():
        raise ValueError("original-scale centroids overflowed")

    elapsed_ms = (perf_counter() - start) * 1000.0
    return ClusteringResult(
        labels=model.labels_.copy(),
        centroids=centroids.copy(),
        scaled_centroids=model.centroids_.copy(),
        feature_names=preprocessor.feature_names_,
        metrics=metrics,
        preprocessing_metadata=preprocessor.get_metadata(),
        algorithm_config={
            "n_clusters": model.n_clusters,
            "init": model.init,
            "max_iter": model.max_iter,
            "tolerance": model.tolerance,
            "n_init": model.n_init,
            "random_state": model.random_state,
            "include_silhouette": config.include_silhouette,
            "silhouette_sample_size": config.silhouette_sample_size,
        },
        iterations=model.iterations_,
        converged=model.converged_,
        processing_time_ms=elapsed_ms,
    )
