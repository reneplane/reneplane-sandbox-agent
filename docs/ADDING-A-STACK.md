# Adding a stack

Today's stacks are Node + Express, Python + FastAPI, Java + Spring Boot (Maven) and .NET + ASP.NET Core. Each runs with PostgreSQL, MySQL or SQL Server. A new one (Go + Gin, Django, NestJS, Laravel, Java with Gradle, …) needs the four pieces below. Each piece is independent and can be tested on its own.

## 1. A stack pack (what learners install)

**Pin the runtime.** In `scripts/pin-runtimes.mjs`, add a builder that pins the runtime's archive per platform (URL + SHA-256), then run `npm run pin-runtimes -- --only=<name>`.

**Describe it.** In `src/runtimes/index.ts`, add its label and a `describe()` case: what goes on PATH, and its environment. Its download cache must go under `PATHS.cache/<ecosystem>`, and anything a pack needs to keep goes under `PATHS.state`.

**Group it into a pack.** In `src/packs/index.ts`, add the pack:
- its id, like `go123`, and a label
- its required runtimes, plus optional ones (a debugger)
- a `finish` step if something must run after unpacking

**Map workspaces to it.** Make `packsFor()` map a workspace's `runtimes.<x>` to the pack.

**Test:** `reneplane-local add <pack>` on Windows, macOS and Linux, then `reneplane-local packs`.

## 2. A checker adapter (the contract)

In `src/codebank/adapters.ts`, add an entry with:
- the pinned-runtime file and its expected version
- the lockfile
- the source files to scan for hard-coded connection details

Add the adapter name to `Adapter` in `src/codebank/spec.ts`.

**Test:** a fixture codebank that breaks each rule, so each failure has a test.

## 3. A template (a healthy starting point)

Under `templates/stacks/<stack-id>/`, add the "Notes" product for the stack:
- one table with a migration
- `GET /api/health` and `GET /api/notes`
- one visible test that writes JUnit XML
- `.reneplane/workspace.yaml` and `.reneplane/grade.yaml`
- the files the adapter requires

Add `templates/stacks/<stack-id>.json` with the codebank.yaml entry for it, and give the example problem (`templates/codebank/problems/NOTE-1`) an allow list for the stack.

**Test:** CI runs `codebank init --stack <id>` followed by `codebank check`; it must pass.

## 4. The grader and debugging

**Grading:**
- `grade.yaml` uses public images only. They must match the allow-list in `src/codebank/spec.ts` and `reneplane-grader/grade/lib/bundle.mjs`; add the stack's image to both.
- The judge needs nothing new: hidden checks are black-box, through the API, the database and the page.

**Debugging:** add a `debug:` section to `workspace.yaml`.
- If the stack's debugger speaks DAP, add an adapter starter in `src/debug/adapters.ts`.
- Otherwise add a bridge, as `src/debug/java.ts` does for JDWP.

## Checklist

- [ ] The pack installs and is reported with its size, on all platforms that have builds
- [ ] `codebank init --stack <id>` + `codebank check` passes on Windows and Linux
- [ ] The compiled grader bundle passes with the reference and fails with an empty patch: `node grade/run.mjs --local --bundle …`
- [ ] F5 stops at a breakpoint in the backend (agent `scripts/dev-debug.ts`)
- [ ] The web app knows the stack's label and icon (`src/mocks/fixtures/stacks.ts`)
