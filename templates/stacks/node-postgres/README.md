# Notes on Node · Express · PostgreSQL

The template's healthy product for this stack: a notes list with pinning.

| Path | What |
| --- | --- |
| `backend/src/server.ts` | Express app: `GET /api/health`, the notes routes, errors as JSON |
| `backend/src/services/notes.service.ts` | the SQL |
| `db/migrations/*.sql` | the schema, applied in order by `npm run migrate` (recorded in `schema_migrations`) |
| `db/seed.sql` | generated from the codebank's `shared/seed/seed.json` when it's compiled; not in git |
| `backend/test/` | visible tests (Vitest + Supertest) against their own database, rebuilt before each test |
| `frontend/` | the codebank's shared React app, mounted here |
| `.reneplane/workspace.yaml` | how Reneplane Local runs it on a learner's computer |
| `.reneplane/grade.yaml` | how the grader builds and runs it (never shipped to learners) |

Replace the product with yours; keep `GET /api/health`, configuration from the environment, and JUnit test output.
