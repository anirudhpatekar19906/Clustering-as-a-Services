"""Alembic migration environment for the Clustering-as-a-Service database.

Reads CAAS_DATABASE_URL through the existing application settings and registers
all SQLAlchemy models for schema migration generation and execution.
"""

from logging.config import fileConfig

from alembic import context
from sqlalchemy.engine import Connection

from backend.database import Base, create_database_engine
from configuration.settings import get_settings
import backend.models  # noqa: F401 - registers tables with Base.metadata


config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Alembic autogenerate compares the database schema with this metadata.
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """Emit migration SQL without connecting to a database (--sql mode)."""
    context.configure(
        url=get_settings().database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_with_connection(connection: Connection) -> None:
    """Use an existing connection and keep migrations transactional."""
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Apply migrations using a database connection.

    Test harnesses may supply a connection via config.attributes['connection'].
    Otherwise, use the same database configuration as the FastAPI backend.
    """
    connection = config.attributes.get("connection")
    if connection is not None:
        run_migrations_with_connection(connection)
        return

    engine = create_database_engine()
    try:
        with engine.connect() as connection:
            run_migrations_with_connection(connection)
    finally:
        engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
