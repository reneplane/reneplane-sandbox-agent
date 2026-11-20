# Notes on .NET · ASP.NET Core · SQL Server

The template's healthy product for this stack: a notes list with pinning.

| Path | What |
| --- | --- |
| `backend/Notes.Api/Program.cs` | minimal API: `GET /api/health`, the notes endpoints, errors as JSON (snake_case) |
| `backend/Notes.Api/Data/` | EF Core: the model (`NotesDb.cs`, snake_case tables) and its migrations |
| `db/seed.sqlserver.sql` | generated from the codebank's `shared/seed/seed.json` when it's compiled; not in git |
| `backend/Notes.Tests/` | visible tests (xUnit + WebApplicationFactory) against their own database |
| `backend/*/packages.lock.json` | every package pinned (`RestorePackagesWithLockFile` in `Directory.Build.props`) |
| `backend/.config/dotnet-tools.json` | `dotnet ef`, pinned |
| `frontend/` | the codebank's shared React app, mounted here |
| `.reneplane/workspace.yaml`, `.reneplane/grade.yaml` | how Reneplane Local runs it, and how the grader does |

SQL Server comes from Reneplane's hosted pool on learners' computers (Docker in CI and the grader). The database template a learner's database starts from is compiled from the migrations: `dotnet ef migrations script --idempotent`, then the seed.

Add a migration with `dotnet ef migrations add <Name> --project Notes.Api` (it needs `DATABASE_URL` set; any SQL Server connection string will do for design time).
