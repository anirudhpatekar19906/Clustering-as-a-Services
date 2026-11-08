"""FastAPI entry point for the Clustering-as-a-Service backend.

Provides health checks, middleware, authentication, and dataset uploads.
Experiment and clustering-job routers will be added incrementally.
"""

import logging
from time import perf_counter
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.database import ping_database
from backend.routers.auth import router as auth_router
from backend.routers.datasets import router as dataset_router
from backend.routers.experiments import router as experiment_router
from configuration.settings import Settings, get_settings
from backend.routers import experiment_plots
from backend.routers import saved_results
from backend.routers import profile
from backend.routers import experiment_exports

logger = logging.getLogger("caas.api")


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the API without connecting to PostgreSQL or Redis at startup."""
    config = settings or get_settings()

    logging.basicConfig(
        level=getattr(logging, config.log_level),
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )

    application = FastAPI(
        title=config.app_name,
        version="0.1.0",
        description="API for dataset segmentation and clustering experiments.",
        debug=config.debug,
    )

    # Keep dependency-injected configuration consistent in isolated tests.
    if settings is not None:
        application.dependency_overrides[get_settings] = lambda: config

    # Both routers share the same version prefix.
    application.include_router(auth_router, prefix=config.api_prefix)
    application.include_router(dataset_router, prefix=config.api_prefix)
    application.include_router(experiment_router, prefix=config.api_prefix)
    application.include_router(experiment_plots.router, prefix=config.api_prefix)
    application.include_router(saved_results.router, prefix=config.api_prefix)
    application.include_router(profile.router, prefix=config.api_prefix)
    application.include_router(experiment_exports.router, prefix=config.api_prefix)

    @application.middleware("http")
    async def log_requests(request: Request, call_next):
        """Attach a unique request ID and log latency for every response."""
        request_id = uuid4().hex
        start = perf_counter()

        try:
            response = await call_next(request)
        except Exception:
            logger.exception(
                "Unhandled API error (request_id=%s)",
                request_id,
            )
            response = JSONResponse(
                status_code=500,
                content={
                    "detail": "Internal server error",
                    "request_id": request_id,
                },
            )

        response.headers["X-Request-ID"] = request_id
        elapsed_ms = (perf_counter() - start) * 1000

        logger.info(
            "%s %s -> %s (%.1f ms; request_id=%s)",
            request.method,
            request.url.path,
            response.status_code,
            elapsed_ms,
            request_id,
        )
        return response

    application.add_middleware(
        CORSMiddleware,
        allow_origins=config.allowed_cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
    )

    @application.get("/", include_in_schema=False)
    def root() -> dict[str, str]:
        return {"service": config.app_name, "docs": "/docs"}

    @application.get("/health", tags=["Health"])
    def health() -> dict[str, str]:
        """Liveness probe independent of external services."""
        return {"status": "ok", "service": "caas-api"}

    @application.get(f"{config.api_prefix}/ready", tags=["Health"])
    def readiness():
        """Report whether PostgreSQL and Redis are reachable."""
        checks = {
            "database": "unavailable",
            "redis": "unavailable",
        }

        try:
            ping_database()
            checks["database"] = "ok"
        except Exception as exc:
            logger.warning(
                "Database readiness check failed (%s)",
                type(exc).__name__,
            )

        try:
            from redis import Redis

            with Redis.from_url(
                config.redis_url,
                socket_connect_timeout=2,
                socket_timeout=2,
            ) as client:
                if client.ping():
                    checks["redis"] = "ok"
        except Exception as exc:
            logger.warning(
                "Redis readiness check failed (%s)",
                type(exc).__name__,
            )

        ready = all(value == "ok" for value in checks.values())

        return JSONResponse(
            status_code=200 if ready else 503,
            content={
                "status": "ready" if ready else "not_ready",
                **checks,
            },
        )

    return application


app = create_app()
