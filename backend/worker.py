"""Start the RQ worker for background clustering tasks.

Usage:
    python -m backend.worker
    python -m backend.worker --burst

Windows uses SimpleWorker with a timer-based timeout mechanism.
Production Linux deployments use the standard process-isolated RQ Worker.
"""

from __future__ import annotations

import argparse
import logging
import os
from collections.abc import Sequence

from redis.exceptions import RedisError
from rq import SimpleWorker, Worker
from rq.timeouts import TimerDeathPenalty

from backend.queue_config import (
    CLUSTERING_QUEUE_NAME,
    create_clustering_queue,
    get_redis_connection,
    get_worker_redis_connection,
)


logger = logging.getLogger("caas.worker")


class WindowsSimpleWorker(SimpleWorker):
    """Development worker compatible with Windows."""

    death_penalty_class = TimerDeathPenalty


def create_worker() -> Worker:
    """Build a worker listening to the clustering queue."""

    connection = get_worker_redis_connection()

    queue = create_clustering_queue(
        connection=connection
    )

    worker_class = (
        WindowsSimpleWorker
        if os.name == "nt"
        else Worker
    )

    return worker_class(
        [queue],
        connection=connection,
    )


def main(argv: Sequence[str] | None = None) -> int:
    """Start the worker and process clustering jobs."""

    parser = argparse.ArgumentParser(
        description=(
            "Execute Clustering-as-a-Service background jobs."
        )
    )

    parser.add_argument(
        "--burst",
        action="store_true",
        help=(
            "Process queued jobs and exit when the queue is empty."
        ),
    )

    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format=(
            "%(asctime)s %(levelname)s "
            "%(name)s: %(message)s"
        ),
    )

    try:
        # Check Redis using the short API connection timeout.
        get_redis_connection().ping()

        worker = create_worker()

        logger.info(
            "Listening on queue %s (worker class: %s)",
            CLUSTERING_QUEUE_NAME,
            type(worker).__name__,
        )

        worker.work(burst=args.burst)

    except RedisError:
        logger.exception(
            "Redis is unavailable; check Docker and CAAS_REDIS_URL"
        )
        return 1

    except KeyboardInterrupt:
        logger.info("Worker interrupted")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
