# Notes on Java · Spring Boot · MySQL

The template's healthy product for this stack: a notes list with pinning.

| Path | What |
| --- | --- |
| `backend/src/main/java/com/notes/` | Spring Boot app: `GET /api/health`, the notes controller (JdbcTemplate, plain SQL), errors as JSON |
| `backend/src/main/resources/db/migration/` | the schema, applied by Flyway when the app starts (and `./mvnw flyway:migrate`) |
| `db/seed.mysql.sql` | generated from the codebank's `shared/seed/seed.json` when it's compiled; not in git |
| `backend/src/test/` | visible tests (JUnit 5 + MockMvc) against their own database, rebuilt before each test |
| `backend/pom.xml` | Java 21; every version comes from the pinned Spring Boot parent |
| `frontend/` | the codebank's shared React app, mounted here |
| `.reneplane/workspace.yaml`, `.reneplane/grade.yaml` | how Reneplane Local runs it, and how the grader does |

Replace the product with yours; keep `GET /api/health`, configuration from the environment, and JUnit test output.
