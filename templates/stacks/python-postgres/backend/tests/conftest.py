"""Tests run against their own database (TEST_DATABASE_URL), rebuilt before every test: every
migration in alembic/versions (yours too), then db/seed.sql. They never touch the data you see in
the preview."""

import os
from pathlib import Path

import pytest

TEST_URL = os.environ.get("TEST_DATABASE_URL") or os.environ["DATABASE_URL"]
os.environ["DATABASE_URL"] = TEST_URL  # before the app creates its engine

from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.db import engine  # noqa: E402
from app.main import app  # noqa: E402

BACKEND = Path(__file__).resolve().parents[1]
SEED = (BACKEND.parent / "db" / "seed.sql").read_text(encoding="utf-8")


@pytest.fixture(autouse=True)
def fresh_database():
    engine.dispose()
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"))
    config = Config(str(BACKEND / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", TEST_URL.replace("%", "%%"))
    config.attributes["configure_logging"] = False
    command.upgrade(config, "head")
    with engine.begin() as conn:
        conn.exec_driver_sql(SEED)
    yield


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def db():
    with engine.begin() as conn:
        yield conn
