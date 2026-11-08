"""Redis and RQ configuration for clustering jobs.

The FastAPI process publishes jobs using a short Redis socket timeout. RQ
workers use a separate client with a longer timeout because they wait for
jobs via blocking Redis commands. This module does not enqueue or run jobs.
"""

from functools import lru_cache

from redis import Redis
from rq import Queue

from configuration.settings import get_settings


CLUSTERING_QUEUE_NAME = "clustering"
CLUSTERING_JOB_TIMEOUT_SECONDS = 30 * 60

REDIS_CONNECT_TIMEOUT_SECONDS = 3
REDIS_API_SOCKET_TIMEOUT_SECONDS = 5

# RQ's default dequeue timeout is approximately 405 seconds. A worker's
# socket timeout must exceed that duration so blocking dequeue is not cut off.
REDIS_WORKER_SOCKET_TIMEOUT_SECONDS = 500


def create_redis_connection(
    redis_url: str | None = None,
    *,
    for_worker: bool = False,
) -> Redis:
    """Construct a Redis client without opening a network connection yet.

    Use for_worker=True for an RQ Worker, not for ordinary API requests.
    RQ requires binary Redis responses (decode_responses=False).
    """
    url = redis_url if redis_url is not None else get_settings().redis_url

    return Redis.from_url(
        url,
        socket_connect_timeout=REDIS_CONNECT_TIMEOUT_SECONDS,
        socket_timeout=(
            REDIS_WORKER_SOCKET_TIMEOUT_SECONDS
            if for_worker
            else REDIS_API_SOCKET_TIMEOUT_SECONDS
        ),
        socket_keepalive=True,
        decode_responses=False,
    )


@lru_cache(maxsize=1)
def get_redis_connection() -> Redis:
    """Reuse the short-timeout Redis client in the API process."""
    return create_redis_connection()


@lru_cache(maxsize=1)
def get_worker_redis_connection() -> Redis:
    """Reuse the long-timeout Redis client in the worker process."""
    return create_redis_connection(for_worker=True)


def create_clustering_queue(connection: Redis | None = None) -> Queue:
    """Construct the shared named queue used to submit clustering jobs.

    The queue itself does not enqueue a task or start a worker.
    """
    redis_connection = (
        connection if connection is not None
        else get_redis_connection()
    )

    return Queue(
        name=CLUSTERING_QUEUE_NAME,
        connection=redis_connection,
        default_timeout=CLUSTERING_JOB_TIMEOUT_SECONDS,
    )


@lru_cache(maxsize=1)
def get_clustering_queue() -> Queue:
    """Reuse the API's queue handle for future experiment submission."""
    return create_clustering_queue()


def ping_redis() -> bool:
    """Check Redis reachability using the API client's bounded timeout."""
    return bool(get_redis_connection().ping())
