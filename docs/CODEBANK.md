# Codebanks

A codebank is one private repository per product. Its `main` branch is the healthy, finished product in every stack it supports. Each problem takes something away from `main`:

- a **bug** brings a bug back
- a **feature** removes a feature
- a **hotfix** adds a production-style bug

Learners get the starter; `main` is the reference.

Codebanks live in the `reneplane` GitHub organisation, named `codebank-<id>`. Locally they sit in `reneplane_project/codebanks/`. `reneplane-local codebank check` enforces everything on this page.

## Layout

```
codebank-shopkart/
├── codebank.yaml                     the product, its stacks, shared folders, the seed
├── shared/frontend/                  copied into every stack's learner tree as frontend/
├── shared/seed/seed.json             one seed for every stack, generated into each engine's SQL
├── stacks/<stack-id>/                one stack's healthy product, laid out as the learner sees it
│   ├── .reneplane/workspace.yaml     how Reneplane Local runs it on a learner's computer
│   ├── .reneplane/grade.yaml         how the grader builds and runs it (never shipped to learners)
│   └── backend/ db/ README.md …
├── problems/<ID>/
│   ├── problem.yaml                  the problem: title, type, branch, allowed files, hidden suite
│   ├── brief.md                      the ticket the learner reads
│   ├── hidden/behaviours.mjs         hidden black-box checks (never shipped to learners)
│   └── <stack-id>/break.patch        only for bugs that never existed in the history
├── history/<stack-id>/*.patch        the git log learners see (git format-patch series)
└── .github/workflows/reneplane.yml   checks on push and PR, compiles on release tags
```

**Stack ids are the variant ids learners pick:**

| Codebank | Stack ids |
|---|---|
| ShopKart | `node-postgres`, `python-postgres`, `java-mysql`, `dotnet-sqlserver` |
| SQL codebank | `postgres`, `mysql`, `sqlserver` |

## codebank.yaml

```yaml
format: 1
id: shopkart                     # the repo is reneplane/codebank-shopkart
name: ShopKart
description: Home goods for 40,000 customers.
stacks:
  node-postgres: { adapter: node, label: Node · Express · PostgreSQL, engine: postgres, seed: db/seed.sql }
  dotnet-sqlserver:
    adapter: dotnet              # node | python | java-maven | dotnet | sql
    label: .NET · ASP.NET Core · SQL Server
    engine: sqlserver            # postgres | mysql | sqlserver
    seed: db/seed.sqlserver.sql  # where the generated seed goes in this stack's tree
    template:                    # SQL Server only: the pool can't run migration tools
      run: dotnet tool restore && dotnet ef migrations script --idempotent --project ShopKart.Api --output "{{out}}"
      cwd: backend
mounts: { frontend: shared/frontend }
seed: shared/seed/seed.json
```

## The Reneplane contract (every stack)

| Rule | Why |
|---|---|
| **Pinned runtime:** `.nvmrc` 22, `.python-version` 3.12, `<java.version>21`, `global.json` 10.x with `rollForward: latestFeature` | The same build on every computer and in the grader |
| **Locked dependencies:** `package-lock.json`, `uv.lock`, pinned `pom.xml` versions, `packages.lock.json` | Repeatable installs, and the shared cache gets reused |
| **Config only from the environment:** `DATABASE_URL`, `PORT`, `ConnectionStrings__Default` | The agent injects the database and ports. Hard-coded hosts and ports fail the check |
| **Migrations committed, with the stack's own tool:** plain SQL, Alembic, Flyway, EF Core | Fixes that change the schema must be migrations |
| **Seed from `seed.json`** | One seed for all stacks |
| **`GET /api/health`** | The agent knows when the backend is ready |
| **Tests write JUnit XML (or TRX)** | One parser for every stack |
| **Visible tests in the stack; hidden checks in `problems/<ID>/hidden/`** | Hidden checks never ship |
| **No outside network calls at runtime** | Works offline, and in the grader's sealed network |
| **Boots from clean in under 3 minutes after install** | Learners aren't kept waiting |
| **`* text=auto eol=lf`, no symlinks or submodules, plain ASCII paths, no names differing only by case** | Windows, macOS and Linux all see the same tree |
| **The frontend's dev server reads its host and allowed hosts from the environment** | Cloud sessions serve it on a public host |

## Problems

### problem.yaml

```yaml
id: SHOP-142
slug: shop-142-cancel-restock      # the platform's mission id
kind: app                          # app | sql
type: bug                          # bug | feature | hotfix
title: Cancelled orders never restore stock
difficulty: medium                 # easy | medium | hard
skills: [Transactions, SQL migrations]
brief: brief.md
branch: bug/142a                   # the learner's branch
preview: /orders/1042              # where the preview opens
minAgentVersion: 0.3.0
history:
  head: { message: "…", author: "Meera Iyer <meera@shopkart.example>", date: "2026-11-15T10:20:00+05:30" }
stacks:
  node-postgres:
    allow: [backend/src/**, backend/test/**, db/migrations/*.sql, frontend/src/**]
    expectFailing: [refuses to cancel an order that is not placed]   # optional
hidden: hidden/behaviours.mjs
# SQL problems also have:
# files: { answer.sql: "{stack}/answer.sql", expected.json: example-output.json }
# sql: { columns: [month, orders, …], orderMatters: true }
```

### One problem is one commit

1. Build the healthy product on `main`.
2. Make the commit that *adds* the feature (or fixes the bug) one squashed commit. It holds the code, the migration, the frontend change and the visible tests' fixes.
3. Put the trailers in the last paragraph of its message:

```
fix(orders): cancelling restores stock and records cancelled_at

Reneplane-Problem: SHOP-142
Reneplane-Type: bug
```

**How the starter is built.** The starter is `main` with that commit taken back, but only the part that lands in each stack's tree.

**Where the visible tests go.** The visible tests that should fail on the starter must not be in that commit: they belong on `main` before it.

**When a later commit gets in the way.** If a later commit touches the same lines, the revert stops applying and `check` names that commit. For bugs that never existed in the history, write `problems/<ID>/<stack>/break.patch` instead (it is applied forward to `main`).

**Merging.** Squash-merge pull requests and keep the trailers in the squashed message. Run `reneplane-local problem new <ID> --from-commit <sha>` to start the problem.yaml.

### Hidden checks

`hidden/behaviours.mjs` exports `behaviours`. Each one is `{ id, name, category, layer, run(t) }` and calls the learner's running API, reads the database, or drives the page with Playwright.

- The same suite serves every stack.
- It must be plain ESM with no imports: it runs inside the grader's judge container.
- SQL problems export `datasets` instead.

The grader runs them when a release is compiled: the starter must fail and the reference must pass. Publish stays blocked until both do.

### The learner's history

`history/<stack>/*.patch` is a `git format-patch` series replayed in order, keeping authors and dates. The problem's `history.head` commit then makes the tree exactly the starter.

- Learners never see the real history; it contains answers.
- The compiler refuses a starter whose history contains any reference file or a `Reneplane-` trailer.

## Where problems are added

**In the codebank**, by commit and pull request. The code, tests and hidden checks are reviewed together, and every later change to the product re-checks them.

**The admin portal does what isn't code:**
- connect a codebank
- review a Draft's check results
- Publish, Unpublish or roll back a version
- choose featured, hidden or beta

## Commands

```sh
reneplane-local codebank init my-product --name "My Product" --stack node-postgres --stack python-postgres
reneplane-local codebank check --quick          # structure only (seconds)
reneplane-local codebank check                  # + every stack boots, + every problem's starter and reference
reneplane-local codebank check --stack java-mysql --problem SHOP-142 --keep   # one pair, keep the work folder
reneplane-local codebank compile --out dist --release v2026.11.1             # bundles + release.json
reneplane-local problem new SHOP-143 --from-commit 1a2b3c4
```

## How it reaches learners

1. **Push:** CI runs `check --quick`. The first report from a repository shows it in the admin portal as *Detected*; an admin clicks Connect.
2. **Pull request:** CI runs the full check on the stacks the PR changes.
3. **Tag `v*`:**
   - CI runs the full check and `compile`, and uploads the bundles to the engine.
   - The engine creates a Draft per problem.
   - The grader verifies each variant: the starter fails the hidden checks, and the reference passes them.
4. **Publish in admin.** Learners mid-attempt stay on the version they started.
