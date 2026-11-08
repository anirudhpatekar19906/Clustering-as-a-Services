"""SQLAlchemy engine, ORM base, and request-scoped database sessions.

The engine is created lazily, so importing this module does not require a
running PostgreSQL server. Each API request gets its own SQLAlchemy Session.
"""

from collections.abc import Generator
from functools import lru_cache

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from configuration.settings import get_settings


class Base(DeclarativeBase):
    """Base class for all database models (users, datasets, jobs, etc.)."""


def create_database_engine(database_url: str | None = None) -> Engine:
    """Create a database engine with bounded connection timeouts."""
    url = database_url if database_url is not None else get_settings().database_url

    options = {
        "pool_pre_ping": True,
        "pool_recycle": 1800,
        "hide_parameters": True,
    }

    if url.startswith("postgresql"):
        options["connect_args"] = {"connect_timeout": 5}
        options["pool_timeout"] = 5

    return create_engine(url, **options)


def create_session_factory(engine: Engine) -> sessionmaker[Session]:
    """Create a factory that supplies independent, short-lived sessions."""
    return sessionmaker(
        bind=engine,
        autoflush=False,
        expire_on_commit=False,
    )


@lru_cache(maxsize=1)
def get_engine() -> Engine:
    """Reuse one connection pool per API or worker process."""
    return create_database_engine()


@lru_cache(maxsize=1)
def get_session_factory() -> sessionmaker[Session]:
    """Reuse the session factory, not individual database sessions."""
    return create_session_factory(get_engine())


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency: one session per request; always release it.

    Application code must explicitly commit successful transactions.
    Errors roll back any uncommitted changes and propagate to the API layer.
    """
    session_factory = get_session_factory()
    with session_factory() as session:
        try:
            yield session
        except Exception:
            session.rollback()
            raise


def ping_database(engine: Engine | None = None) -> None:
    """Check database connectivity; raise on failure (for health checks)."""
    target_engine = engine if engine is not None else get_engine()
    with target_engine.connect() as connection:
        connection.execute(text("SELECT 1"))
