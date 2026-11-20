# A Reneplane codebank

This repository holds a product, on one or more stacks, and the problems learners solve in it on Reneplane Workspace. It started from the Notes template (`reneplane-local codebank init`): a tiny notes list with pinning, and one example problem, NOTE-1. Replace Notes with your product, keep the structure.

```
codebank.yaml             the codebank: its stacks, the shared frontend, the seed data
shared/frontend/          one React app, mounted into every stack as frontend/
shared/seed/seed.json     development data; turned into SQL for each database when compiled
stacks/<stack>/           the product's backend on one stack, with how it runs (.reneplane/)
problems/<ID>/            a problem: problem.yaml, the ticket (brief.md), hidden checks
.github/workflows/        checks every push, and releases on v* tags
```

## Working on it

```sh
reneplane-local codebank check            # structure: seconds
reneplane-local codebank check --full     # boots every stack, runs every problem (needs Docker for SQL Server)
```

Everything `check` asks for is in `docs/CODEBANK.md` of [reneplane-sandbox-agent](https://github.com/reneplane/reneplane-sandbox-agent): the pinned runtime, the lockfile, migrations, configuration only from the environment, `GET /api/health`, and JUnit or TRX test output.

## Adding a problem

1. On `main`, the product works and the visible tests that will catch the bug pass.
2. One squashed commit introduces the fix (or the feature), with the trailers `Reneplane-Problem: <ID>` and `Reneplane-Type: bug|feature|hotfix` in its last paragraph. The starter learners get is `main` with that commit taken back.
3. `reneplane-local problem new <ID> --from-commit <sha>` writes `problems/<ID>/problem.yaml`. Add the ticket and the hidden checks.
4. Open a pull request: CI runs the full check on the stacks it touches.

NOTE-1 uses `problems/NOTE-1/<stack>/break.patch` instead of a commit, because that bug never existed in this history. Delete NOTE-1 once you have a problem of your own.

## Releasing

Tag a commit on `main` `v2026.11.1` (or `v2026.11.1-rc1` for staging). CI checks everything, compiles the release, and uploads it; the grader verifies that each problem's starter fails and its reference passes on every stack. The new versions then show in the admin portal under Workspace › Problems, ready to publish.

The first push makes the codebank appear in the admin portal under Workspace › Codebanks as Detected; connect it there before its first release.
