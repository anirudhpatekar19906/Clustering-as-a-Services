"""K-Means implemented from scratch with NumPy (no sklearn clustering).

The class accepts the numeric matrix produced by NumericPreprocessor.
Training uses deterministic K-Means++ or random initialization, Lloyd's
assignment/mean-update steps, and explicit empty-cluster repair.
"""

from __future__ import annotations

from typing import Literal

import numpy as np
from numpy.typing import ArrayLike, NDArray


class KMeansFromScratch:
    """Fit K-Means centroids and predict the closest cluster for new rows.

    The fitted attributes follow familiar conventions:
    centroids_, labels_, inertia_, iterations_, converged_, cluster_sizes_.
    """

    def __init__(
        self,
        n_clusters: int,
        max_iter: int = 300,
        tolerance: float = 1e-4,
        random_state: int = 42,
        init: Literal["kmeans++", "random"] = "kmeans++",
        n_init: int = 3,
    ) -> None:
        if isinstance(n_clusters, bool) or not isinstance(n_clusters, (int, np.integer)) or n_clusters < 1:
            raise ValueError("n_clusters must be a positive integer")
        if isinstance(max_iter, bool) or not isinstance(max_iter, (int, np.integer)) or max_iter < 1:
            raise ValueError("max_iter must be a positive integer")
        if isinstance(n_init, bool) or not isinstance(n_init, (int, np.integer)) or n_init < 1:
            raise ValueError("n_init must be a positive integer")
        if isinstance(random_state, bool) or not isinstance(random_state, (int, np.integer)) or random_state < 0:
            raise ValueError("random_state must be a non-negative integer")
        if isinstance(tolerance, bool) or not isinstance(tolerance, (int, float, np.number)) or not np.isfinite(tolerance) or tolerance < 0:
            raise ValueError("tolerance must be a finite, non-negative number")
        if init not in ("kmeans++", "random"):
            raise ValueError("init must be 'kmeans++' or 'random'")

        self.n_clusters = int(n_clusters)
        self.max_iter = int(max_iter)
        self.tolerance = float(tolerance)
        self.random_state = int(random_state)
        self.init = init
        self.n_init = int(n_init)

        self.centroids_: NDArray[np.float64] | None = None
        self.labels_: NDArray[np.int64] | None = None
        self.inertia_: float | None = None
        self.iterations_: int = 0
        self.converged_: bool = False
        self.cluster_sizes_: NDArray[np.int64] | None = None
        self.n_features_in_: int | None = None

    @staticmethod
    def _validate_matrix(data: ArrayLike, *, name: str) -> NDArray[np.float64]:
        try:
            values = np.asarray(data, dtype=np.float64)
        except (ValueError, TypeError, OverflowError) as exc:
            raise ValueError(f"{name} must contain numeric values") from exc
        if values.ndim != 2 or not values.shape[0] or not values.shape[1]:
            raise ValueError(f"{name} must be a nonempty two-dimensional matrix")
        if not np.isfinite(values).all():
            raise ValueError(f"{name} must contain only finite values")
        return values

    @staticmethod
    def _squared_distances(
        values: NDArray[np.float64], centroids: NDArray[np.float64]
    ) -> NDArray[np.float64]:
        """Manually compute squared Euclidean distances for one row batch."""
        with np.errstate(over="ignore", invalid="ignore"):
            difference = values[:, None, :] - centroids[None, :, :]
            squared = np.sum(difference * difference, axis=2)
        if not np.isfinite(squared).all():
            raise ValueError("squared distances overflowed; rescale the features")
        return squared

    @classmethod
    def _assign(
        cls, values: NDArray[np.float64], centroids: NDArray[np.float64]
    ) -> tuple[NDArray[np.int64], NDArray[np.float64]]:
        """Assign points to nearest centroids, processing bounded-size batches."""
        count = values.shape[0]
        labels = np.empty(count, dtype=np.int64)
        distances = np.empty(count, dtype=np.float64)
        # Bound the temporary (rows x clusters x dimensions) distance array.
        chunk_rows = max(1, 1_000_000 // (len(centroids) * values.shape[1]))
        for start in range(0, count, chunk_rows):
            stop = min(start + chunk_rows, count)
            squared = cls._squared_distances(values[start:stop], centroids)
            selected = np.argmin(squared, axis=1)
            labels[start:stop] = selected
            distances[start:stop] = squared[np.arange(stop - start), selected]
        return labels, distances

    def _initialize(
        self, values: NDArray[np.float64], rng: np.random.Generator
    ) -> NDArray[np.float64]:
        """Seed distinct centroids using manually calculated K-Means++ weights."""
        if self.init == "random":
            unique_rows = np.unique(values, axis=0)
            return unique_rows[rng.choice(len(unique_rows), self.n_clusters, replace=False)].copy()

        first = int(rng.integers(len(values)))
        centroids = [values[first].copy()]
        for _ in range(1, self.n_clusters):
            _, nearest_squared = self._assign(values, np.asarray(centroids))
            weight_sum = float(np.sum(nearest_squared))
            if not np.isfinite(weight_sum) or weight_sum <= 0:
                raise ValueError("cannot initialize distinct centroids")
            probability = nearest_squared / weight_sum
            chosen = int(rng.choice(len(values), p=probability))
            centroids.append(values[chosen].copy())
        return np.asarray(centroids, dtype=np.float64)

    def _run_once(
        self, values: NDArray[np.float64], rng: np.random.Generator
    ) -> tuple[NDArray[np.float64], NDArray[np.int64], float, int, bool] | None:
        centroids = self._initialize(values, rng)
        converged = False
        iterations = 0

        for iteration in range(1, self.max_iter + 1):
            labels, nearest_squared = self._assign(values, centroids)
            counts = np.bincount(labels, minlength=self.n_clusters)

            # When a cluster is empty, move a far-away row out of a cluster
            # containing at least two rows. This prevents dividing by zero.
            for empty in np.flatnonzero(counts == 0):
                donor_rows = np.flatnonzero(counts[labels] > 1)
                if not len(donor_rows):
                    return None
                moved = int(donor_rows[np.argmax(nearest_squared[donor_rows])])
                counts[labels[moved]] -= 1
                labels[moved] = int(empty)
                counts[empty] += 1

            updated = np.empty_like(centroids)
            for cluster in range(self.n_clusters):
                updated[cluster] = values[labels == cluster].mean(axis=0)
            if not np.isfinite(updated).all():
                raise ValueError("centroid update overflowed; rescale the features")

            movement = float(np.max(np.linalg.norm(updated - centroids, axis=1)))
            centroids = updated
            iterations = iteration
            new_labels, _ = self._assign(values, centroids)
            if movement <= self.tolerance and np.array_equal(labels, new_labels):
                converged = True
                break

        # Always report labels and SSE for the FINAL centroids (not the
        # previous iteration's centers). Reject rather than report empty groups.
        final_labels, nearest_squared = self._assign(values, centroids)
        if np.any(np.bincount(final_labels, minlength=self.n_clusters) == 0):
            return None
        inertia = float(np.sum(nearest_squared))
        if not np.isfinite(inertia):
            raise ValueError("inertia overflowed; rescale the features")
        return centroids, final_labels, inertia, iterations, converged

    def fit(self, features: ArrayLike) -> KMeansFromScratch:
        """Learn centroids via repeated assignment and arithmetic-mean updates."""
        # A failed refit must not leave a previously fitted model available.
        self.centroids_ = None
        self.labels_ = None
        self.inertia_ = None
        self.cluster_sizes_ = None
        self.iterations_ = 0
        self.converged_ = False
        self.n_features_in_ = None

        values = self._validate_matrix(features, name="features")
        if self.n_clusters > len(values):
            raise ValueError("n_clusters cannot exceed the number of rows")
        if len(np.unique(values, axis=0)) < self.n_clusters:
            raise ValueError("n_clusters cannot exceed the number of distinct rows")

        rng = np.random.default_rng(self.random_state)
        best = None
        for _ in range(self.n_init):
            candidate = self._run_once(values, rng)
            if candidate is not None and (best is None or candidate[2] < best[2]):
                best = candidate
        if best is None:
            raise ValueError("unable to form nonempty clusters; try fewer clusters or more iterations")

        self.centroids_, self.labels_, self.inertia_, self.iterations_, self.converged_ = best
        self.cluster_sizes_ = np.bincount(self.labels_, minlength=self.n_clusters)
        self.n_features_in_ = values.shape[1]
        return self

    def predict(self, features: ArrayLike) -> NDArray[np.int64]:
        """Assign unseen rows to their closest fitted centroid."""
        if self.centroids_ is None:
            raise RuntimeError("fit() must be called before predict()")
        values = self._validate_matrix(features, name="features")
        if values.shape[1] != self.n_features_in_:
            raise ValueError(f"features must contain {self.n_features_in_} columns")
        labels, _ = self._assign(values, self.centroids_)
        return labels

    def fit_predict(self, features: ArrayLike) -> NDArray[np.int64]:
        """Fit and return cluster labels for the training observations."""
        self.fit(features)
        assert self.labels_ is not None
        return self.labels_.copy()
