# Notes on Python · FastAPI · PostgreSQL

The template's healthy product for this stack: a notes list with pinning.

| Path | What |
| --- | --- |
| `backend/app/main.py` | FastAPI app: `GET /api/health`, the notes routes, errors as JSON |
| `backend/app/services/notes.py` | the SQL (SQLAlchemy Core, plain SQL text) |
| `backend/alembic/versions/` | the schema, applied in order by `alembic upgrade head` |
| `db/seed.sql` | generated from the codebank's `shared/seed/seed.json` when it's compiled; not in git |
| `backend/tests/` | visible tests (pytest + TestClient) against their own database, rebuilt before each test |
| `backend/uv.lock` | every dependency pinned; `uv sync --frozen` installs exactly these |
| `frontend/` | the codebank's shared React app, mounted here |
| `.reneplane/workspace.yaml`, `.reneplane/grade.yaml` | how Reneplane Local runs it, and how the grader does |

Replace the product with yours; keep `GET /api/health`, configuration from the environment, and JUnit test output.
