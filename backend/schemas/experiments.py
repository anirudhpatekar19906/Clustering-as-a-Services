"""Pydantic contracts for submitting and inspecting clustering experiments.

This module validates HTTP payloads; executing ML work and creating database
records belong to the API and worker layers.
"""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

if TYPE_CHECKING:
    from clustering_service.service import ClusteringConfig


ScalingMethod = Literal["none", "standardize", "minmax"]
MissingMethod = Literal["error", "median", "mean", "zero"]
InitializationMethod = Literal["kmeans++", "random"]
ExperimentStatus = Literal["queued", "running", "completed", "failed", "cancelled"]


class ExperimentCreateRequest(BaseModel):
    """Validated input for scheduling one K-Means experiment."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    dataset_id: UUID
    n_clusters: int = Field(ge=2, le=50)
    features: list[str] | None = Field(default=None, min_length=1, max_length=100)
    scaling: ScalingMethod = "standardize"
    missing_values: MissingMethod = "median"
    init: InitializationMethod = "kmeans++"
    max_iter: int = Field(default=300, ge=1, le=1000)
    tolerance: float = Field(default=1e-4, ge=0)
    n_init: int = Field(default=3, ge=1, le=20)
    random_state: int = Field(default=42, ge=0, le=4_294_967_295)
    include_silhouette: bool = True
    silhouette_sample_size: int = Field(default=1500, ge=2, le=1500)

    @field_validator("features")
    @classmethod
    def validate_features(cls, features: list[str] | None) -> list[str] | None:
        if features is None:
            return None  # The preprocessing module will select numeric columns.

        clean = [name.strip() for name in features]
        if any(not name for name in clean):
            raise ValueError("feature names cannot be blank")
        if len({name.casefold() for name in clean}) != len(clean):
            raise ValueError("feature names must be unique")
        return clean

    @model_validator(mode="after")
    def validate_silhouette_sample(self) -> ExperimentCreateRequest:
        if self.include_silhouette and self.silhouette_sample_size < self.n_clusters:
            raise ValueError(
                "silhouette_sample_size must be at least n_clusters "
                "when silhouette evaluation is enabled"
            )
        return self

    def to_clustering_config(self) -> ClusteringConfig:
        """Translate HTTP options into the File 24 orchestration configuration."""
        from clustering_service.service import ClusteringConfig

        return ClusteringConfig(**self.model_dump(exclude={"dataset_id"}))


class ExperimentSubmittedResponse(BaseModel):
    """Returned only after a background job has been successfully enqueued."""

    model_config = ConfigDict(extra="forbid")

    experiment_id: UUID
    job_id: UUID
    status: Literal["queued"] = "queued"
    message: str = "Experiment queued for processing"


class ClusteringMetricsResponse(BaseModel):
    """Metrics returned by clustering_service.metrics.ClusteringMetrics.to_dict()."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    sse: float = Field(ge=0)
    cluster_sizes: dict[int, int]
    silhouette_score: float | None = Field(default=None, ge=-1, le=1)
    n_samples: int = Field(ge=1)
    n_clusters: int = Field(ge=1)
    silhouette_sample_size: int = Field(ge=0)
    silhouette_is_approximate: bool


class PreprocessingMetadataResponse(BaseModel):
    """Learned parameters recorded by NumericPreprocessor.get_metadata()."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    features: list[str]
    method: ScalingMethod
    missing_values: MissingMethod
    imputation_values: list[float]
    offsets: list[float]
    scales: list[float]
    n_samples_fit: int = Field(ge=2)


class AlgorithmConfigResponse(BaseModel):
    """K-Means settings captured by the orchestration service."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    n_clusters: int = Field(ge=2)
    init: InitializationMethod
    max_iter: int = Field(ge=1)
    tolerance: float = Field(ge=0)
    n_init: int = Field(ge=1)
    random_state: int = Field(ge=0)
    include_silhouette: bool
    silhouette_sample_size: int = Field(ge=2)


class ClusteringResultResponse(BaseModel):
    """Matches ClusteringResult.to_dict(); labels are optional due to size."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    algorithm: Literal["custom_kmeans"]
    model_version: str
    n_samples: int = Field(ge=1)
    n_clusters: int = Field(ge=2)
    features: list[str]
    centroids: list[list[float]]
    scaled_centroids: list[list[float]]
    metrics: ClusteringMetricsResponse
    preprocessing_config: PreprocessingMetadataResponse
    algorithm_config: AlgorithmConfigResponse
    iterations: int = Field(ge=1)
    converged: bool
    processing_time_ms: float = Field(ge=0)
    labels: list[int] | None = None


class ExperimentStatusResponse(BaseModel):
    """Status envelope for a future authenticated experiment-detail endpoint."""

    model_config = ConfigDict(extra="forbid")

    experiment_id: UUID
    job_id: UUID | None = None
    status: ExperimentStatus
    created_at: datetime
    updated_at: datetime | None = None
    result: ClusteringResultResponse | None = None
    error_message: str | None = None
