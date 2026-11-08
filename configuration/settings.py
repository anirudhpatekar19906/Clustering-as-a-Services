"""Central configuration for the Clustering-as-a-Service backend.

Environment variables use the CAAS_ prefix (for example, CAAS_REDIS_URL).
A project-root .env file is supported for local development.
"""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


PROJECT_ROOT = Path(__file__).resolve().parent.parent
LOCAL_DATABASE_URL = "postgresql+psycopg://caas:caas@localhost:5432/caas"


class Settings(BaseSettings):
    """Validated settings shared by the API and background workers."""

    model_config = SettingsConfigDict(
        env_prefix="CAAS_",
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Application
    app_name: str = "Clustering-as-a-Service"
    environment: Literal["development", "test", "production"] = "development"
    debug: bool = False
    api_prefix: str = "/api/v1"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"

    # Infrastructure: use CAAS_* overrides for Docker/cloud hostnames.
    database_url: str = LOCAL_DATABASE_URL
    redis_url: str = "redis://localhost:6379/0"
    queue_name: str = "clustering"
    job_timeout_seconds: int = Field(default=600, ge=30, le=3600)
    job_result_ttl_seconds: int = Field(default=86400, ge=60)
    cache_ttl_seconds: int = Field(default=3600, ge=0)

    # Dataset uploads and processing limits
    upload_dir: Path = PROJECT_ROOT / "storage" / "uploads"
    max_upload_size_mb: int = Field(default=25, ge=1, le=200)
    max_dataset_rows: int = Field(default=100_000, ge=2)
    max_dataset_columns: int = Field(default=100, ge=2)

    # Reproducible clustering defaults
    default_random_seed: int = 42
    kmeans_max_iterations: int = Field(default=300, ge=1)
    kmeans_tolerance: float = Field(default=1e-4, gt=0)
    max_clusters: int = Field(default=20, ge=2)
    silhouette_sample_size: int = Field(default=1500, ge=2)

    # Authentication: no hard-coded signing secret, even for development.
    jwt_secret_key: SecretStr | None = Field(default=None, repr=False)
    jwt_algorithm: Literal["HS256"] = "HS256"
    access_token_expire_minutes: int = Field(default=60, ge=1)

    @field_validator("upload_dir")
    @classmethod
    def resolve_upload_dir(cls, value: Path) -> Path:
        """Make a relative upload path independent of the working directory."""
        path = value if value.is_absolute() else PROJECT_ROOT / value
        return path.resolve()

    @property
    def allowed_cors_origins(self) -> list[str]:
        """Parse comma-separated browser origins for FastAPI CORSMiddleware."""
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def max_upload_size_bytes(self) -> int:
        return self.max_upload_size_mb * 1024 * 1024

    def require_jwt_secret_key(self) -> str:
        """Fail clearly if token signing is attempted without a configured key."""
        if self.jwt_secret_key is None:
            raise RuntimeError("Set CAAS_JWT_SECRET_KEY before using authentication.")
        return self.jwt_secret_key.get_secret_value()

    @model_validator(mode="after")
    def validate_production_security(self) -> "Settings":
        """Prevent accidental production use of development-only defaults."""
        if self.environment == "production":
            if self.debug:
                raise ValueError("CAAS_DEBUG must be false in production.")
            if self.database_url == LOCAL_DATABASE_URL:
                raise ValueError("Set CAAS_DATABASE_URL to a production database URL.")
            if self.jwt_secret_key is None or len(self.jwt_secret_key.get_secret_value()) < 32:
                raise ValueError("Production requires CAAS_JWT_SECRET_KEY of at least 32 characters.")
            if not self.allowed_cors_origins or "*" in self.allowed_cors_origins:
                raise ValueError("Set explicit CAAS_CORS_ORIGINS in production; '*' is not allowed.")
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Reuse the same validated configuration within each Python process."""
    return Settings()
