"""The database connection, and transaction() for changes that must happen together."""

import os
from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import Connection, create_engine

engine = create_engine(os.environ["DATABASE_URL"], pool_pre_ping=True)


@contextmanager
def connection() -> Iterator[Connection]:
    """For queries that don't need a transaction of their own (autocommits)."""
    with engine.begin() as conn:
        yield conn


@contextmanager
def transaction() -> Iterator[Connection]:
    """Run several statements as one unit: they all commit together, or none of them do.

        with transaction() as tx:
            tx.execute(text("UPDATE ..."), {"id": order_id})
            tx.execute(text("UPDATE ..."), {"id": order_id})
    """
    with engine.begin() as tx:
        yield tx
