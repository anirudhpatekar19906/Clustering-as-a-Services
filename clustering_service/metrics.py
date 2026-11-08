"""Manual clustering evaluation: SSE, cluster sizes, and silhouette score.

Silhouette uses deterministic stratified sampling for large datasets to keep
its quadratic pairwise-distance cost bounded. No sklearn metrics are used.
"""

from dataclasses import dataclass

import numpy as np
from numpy.typing import ArrayLike, NDArray


@dataclass(frozen=True)
class ClusteringMetrics:
    """JSON-friendly summary of a fitted clustering result."""

    sse: float
    cluster_sizes: dict[int, int]
    silhouette_score: float | None
    n_samples: int
    n_clusters: int
    silhouette_sample_size: int
    silhouette_is_approximate: bool

    def to_dict(self) -> dict[str, object]:
        """Convert NumPy-derived metrics to JSON-serializable Python values."""
        return {
            "sse": self.sse,
            "cluster_sizes": self.cluster_sizes,
            "silhouette_score": self.silhouette_score,
            "n_samples": self.n_samples,
            "n_clusters": self.n_clusters,
            "silhouette_sample_size": self.silhouette_sample_size,
            "silhouette_is_approximate": self.silhouette_is_approximate,
        }


def _validate_features(features: ArrayLike) -> NDArray[np.float64]:
    try:
        values = np.asarray(features, dtype=np.float64)
    except (ValueError, TypeError, OverflowError) as exc:
        raise ValueError("features must be numeric") from exc

    if values.ndim != 2 or not all(values.shape):
        raise ValueError("features must be a nonempty 2D matrix")

    if not np.isfinite(values).all():
        raise ValueError("features must contain only finite values")

    return values


def _validate_labels(labels: ArrayLike, row_count: int) -> NDArray[np.int64]:
    raw = np.asarray(labels)

    if raw.ndim != 1 or len(raw) != row_count:
        raise ValueError(
            "labels must be a 1D array matching the number of rows"
        )

    if not np.issubdtype(raw.dtype, np.integer):
        raise ValueError("labels must be integer cluster identifiers")

    if np.any(raw < 0) or np.any(raw > np.iinfo(np.int64).max):
        raise ValueError(
            "labels must be nonnegative integers within int64 range"
        )

    return raw.astype(np.int64, copy=False)


def _validate_result(
    features: ArrayLike,
    labels: ArrayLike,
    centroids: ArrayLike,
) -> tuple[
    NDArray[np.float64],
    NDArray[np.int64],
    NDArray[np.float64],
]:
    values = _validate_features(features)
    assignments = _validate_labels(labels, len(values))
    centers = _validate_features(centroids)

    if values.shape[1] != centers.shape[1]:
        raise ValueError(
            "features and centroids must have the same column count"
        )

    counts = (
        np.bincount(assignments, minlength=len(centers))
        if assignments.max() < len(centers)
        else None
    )

    if counts is None or np.any(counts == 0):
        raise ValueError(
            "labels must reference every centroid with no empty clusters"
        )

    return values, assignments, centers


def _sse(
    values: NDArray[np.float64],
    labels: NDArray[np.int64],
    centers: NDArray[np.float64],
) -> float:
    """Calculate squared residuals in batches to bound temporary memory."""

    rows_per_batch = max(1, 1_000_000 // values.shape[1])
    total = 0.0

    for start in range(0, len(values), rows_per_batch):
        end = min(start + rows_per_batch, len(values))

        with np.errstate(over="ignore", invalid="ignore"):
            residuals = values[start:end] - centers[labels[start:end]]
            total += float(
                np.einsum("ij,ij->", residuals, residuals)
            )

        if not np.isfinite(total):
            raise ValueError("SSE overflowed; scale the input features")

    return total


def calculate_sse(
    features: ArrayLike,
    labels: ArrayLike,
    centroids: ArrayLike,
) -> float:
    """Within-cluster sum of squared Euclidean distances (K-Means inertia)."""

    values, assignments, centers = _validate_result(
        features, labels, centroids
    )
    return _sse(values, assignments, centers)


def _stratified_indices(
    labels: NDArray[np.int64],
    sample_size: int,
    seed: int,
) -> NDArray[np.int64]:
    """Sample without replacement, retaining representatives of every cluster."""

    n = len(labels)

    if n <= sample_size:
        return np.arange(n, dtype=np.int64)

    cluster_ids, counts = np.unique(labels, return_counts=True)
    k = len(cluster_ids)

    if sample_size < k:
        raise ValueError(
            "sample_size must be at least the number of clusters"
        )

    quotas = np.where(counts > 1, 2, 1)

    if int(quotas.sum()) > sample_size:
        quotas = np.ones(k, dtype=np.int64)

    # Fill remaining places while approximating cluster proportions.
    targets = counts.astype(float) * (sample_size / n)

    for _ in range(sample_size - int(quotas.sum())):
        available = quotas < counts
        priority = np.where(
            available, targets - quotas, -np.inf
        )
        quotas[int(np.argmax(priority))] += 1

    rng = np.random.default_rng(seed)

    chosen = [
        rng.choice(
            np.flatnonzero(labels == cid),
            size=int(quota),
            replace=False,
        )
        for cid, quota in zip(cluster_ids, quotas)
    ]

    return np.sort(np.concatenate(chosen)).astype(np.int64)


def _silhouette_for_sample(
    values: NDArray[np.float64],
    labels: NDArray[np.int64],
) -> float:
    """Compute mean silhouette from Euclidean distances, without sklearn."""

    cluster_ids, counts = np.unique(labels, return_counts=True)
    groups = [
        np.flatnonzero(labels == cid)
        for cid in cluster_ids
    ]

    scores_total = 0.0
    n, dimension = values.shape

    # Keep the (batch x sample x dimension) temporary array bounded.
    rows_per_batch = max(
        1, min(64, 500_000 // (n * dimension))
    )

    for start in range(0, n, rows_per_batch):
        end = min(n, start + rows_per_batch)

        with np.errstate(over="ignore", invalid="ignore"):
            differences = (
                values[start:end, None, :]
                - values[None, :, :]
            )
            distances = np.sqrt(
                np.sum(differences * differences, axis=2)
            )

        if not np.isfinite(distances).all():
            raise ValueError(
                "silhouette distances overflowed; scale the features"
            )

        mean_distances = np.column_stack([
            distances[:, indices].mean(axis=1)
            for indices in groups
        ])

        group_indices = np.searchsorted(
            cluster_ids, labels[start:end]
        )
        row_indices = np.arange(end - start)
        own_sizes = counts[group_indices]

        # Exclude the observation itself using (cluster size - 1).
        own_sums = (
            mean_distances[row_indices, group_indices]
            * own_sizes
        )

        within = np.divide(
            own_sums,
            own_sizes - 1,
            out=np.zeros_like(own_sums),
            where=own_sizes > 1,
        )

        mean_distances[row_indices, group_indices] = np.inf
        nearest_other = mean_distances.min(axis=1)

        denominator = np.maximum(within, nearest_other)

        scores = np.divide(
            nearest_other - within,
            denominator,
            out=np.zeros_like(within),
            where=(denominator > 0) & (own_sizes > 1),
        )

        scores_total += float(scores.sum())

    return float(np.clip(scores_total / n, -1.0, 1.0))


def calculate_silhouette_score(
    features: ArrayLike,
    labels: ArrayLike,
    *,
    sample_size: int = 1500,
    random_state: int = 42,
) -> float:
    """Mean silhouette, exact up to sample_size and approximate above it.

    The sample is stratified to include each cluster. Singleton observations
    receive silhouette 0 by convention. For a single cluster, the metric is
    undefined and ValueError is raised.
    """

    values = _validate_features(features)
    assignments = _validate_labels(labels, len(values))

    if (
        isinstance(sample_size, bool)
        or not isinstance(sample_size, (int, np.integer))
        or sample_size < 2
    ):
        raise ValueError("sample_size must be an integer >= 2")

    if (
        isinstance(random_state, bool)
        or not isinstance(random_state, (int, np.integer))
        or random_state < 0
    ):
        raise ValueError("random_state must be a nonnegative integer")

    if len(np.unique(assignments)) < 2:
        raise ValueError(
            "silhouette score requires at least two clusters"
        )

    selected = _stratified_indices(
        assignments, int(sample_size), int(random_state)
    )

    return _silhouette_for_sample(
        values[selected], assignments[selected]
    )


def evaluate_clustering(
    features: ArrayLike,
    labels: ArrayLike,
    centroids: ArrayLike,
    *,
    include_silhouette: bool = True,
    silhouette_sample_size: int = 1500,
    random_state: int = 42,
) -> ClusteringMetrics:
    """Evaluate model outputs with full-data SSE and optional silhouette."""

    values, assignments, centers = _validate_result(
        features, labels, centroids
    )

    counts = np.bincount(
        assignments, minlength=len(centers)
    )

    actual_sample_size = 0
    silhouette: float | None = None

    if include_silhouette and len(centers) >= 2:
        silhouette = calculate_silhouette_score(
            values,
            assignments,
            sample_size=silhouette_sample_size,
            random_state=random_state,
        )
        actual_sample_size = min(
            len(values), silhouette_sample_size
        )

    return ClusteringMetrics(
        sse=_sse(values, assignments, centers),
        cluster_sizes={
            int(i): int(count)
            for i, count in enumerate(counts)
        },
        silhouette_score=silhouette,
        n_samples=len(values),
        n_clusters=len(centers),
        silhouette_sample_size=actual_sample_size,
        silhouette_is_approximate=(
            actual_sample_size > 0
            and actual_sample_size < len(values)
        ),
    )
