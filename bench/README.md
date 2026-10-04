# bench

The load harness quickdraw-core releases are measured with. It runs a busy
project board (many viewers, a fleet of writers) against an app built on a
specific quickdraw-core version, and records what that version costs. It is a
release tool, not a CI gate: CI only runs its unit tests. The measurement
rules are in [docs/benchmarks.md](../docs/benchmarks.md).

## Running it

Needs Docker (for the benchmark's own Postgres), Linux (`taskset`, `/proc`)
and a free host port 5544 (Postgres) and 4090 (the app server).

```bash
bun install
bun run --filter bench bench -- --scenario board-steady --quick              # 4.1 smoke run, about 20 s
bun run --filter bench bench -- --target v5 --scenario board-steady --quick  # the same on 5.0
bun run --filter bench bench -- --repetitions 3                              # every scenario, 3 times each
bun run --filter bench bench -- --repetitions 3 --baseline                   # also writes baselines/ + reports/
bun run --filter bench bench -- --help
```

`--target` picks the app under `apps/` and the client that speaks its wire
protocol: `v4` (the default) or `v5`. The `bench` script builds the
workspace's `@fitzzero/quickdraw-core` first (turbo, cached), since `apps/v5`
and the 5.0 driver run on its `dist/`. `--label` files the results under
another name than the installed version (`--label 5.0.0` for a prerelease
build), and `--cpu-prof` writes a V8 CPU profile of each server process to
`results/logs/<run>/profiles/` (profiling slows the server: never compare a
profiled run).

The runner starts Postgres (`docker compose -p quickdraw-bench`, host port
5544, cpuset 6-9, data in tmpfs) if it is not already running, and stops it
again at the end if it started it (`--keep-db` leaves it up). It never
touches any other container. Each run of a scenario then reseeds the
database, starts a fresh app server pinned with `taskset -c 2,3`, drives it
from the runner's own process (pinned to cpus 10,11), and stops the server.
Pick other cpus or ports with `--server-cpus`, `--loadgen-cpus`, `--pg-cpus`,
`--port` and `--pg-port`; the result file records whatever was used.

Output:

| Path                       | What                                                                                  | Committed |
| -------------------------- | ------------------------------------------------------------------------------------- | --------- |
| `baselines/<version>.json` | A `--baseline` run's full result                                                      | yes       |
| `reports/<version>.md`     | That run as a readable report, or the comparison it was measured in (`5.0.0.md`)      | yes       |
| `comparisons/<version>/`   | The old version's runs a comparison was made from (`4.1.0-first`, `4.1.0-second`)     | yes       |
| `results/`                 | Every other run's JSON and report, server logs, profiles, the generated workload file | no        |
| `result.schema.json`       | JSON Schema for result files, generated from `src/result-schema.ts`                   | yes       |

After changing `src/result-schema.ts`, run `bun run --filter bench schema`;
`src/report.test.ts` fails until the committed schema matches, and checks
every committed result file against it. After changing how reports are
written, re-render one from its JSON without rerunning anything:
`bun run --filter bench report -- baselines/4.1.0.json reports/4.1.0.md`, or
for a comparison the `compare` command below.

## Layout

```
bench/
├── src/                 the runner (workspace package "bench")
│   ├── runner.ts        entry point; cli.ts parses options
│   ├── workload.ts      the board every app is seeded with (deterministic)
│   ├── scenarios/       board-steady, board-burst, reconnect-storm, fat-read
│   ├── drivers/         one client per target behind types.ts; writes.ts is the shared write sequence
│   │   ├── v4/          4.1 wire protocol: viewer, writer, connection
│   │   └── v5/          protocol 5 on the 5.0 client: viewer, writer, plain connection
│   ├── env/             Docker, the app server process, machine description
│   ├── report.ts        result JSON + Markdown; summary.ts does medians and spread
│   ├── compare.ts       matched comparisons; compare-report.ts renders them
│   └── result-schema.ts the result file's schema
├── apps/v4/             the board app on the published @fitzzero/quickdraw-core 4.1.0
├── apps/v5/             the same board on this workspace's @fitzzero/quickdraw-core (5.0)
├── baselines/  reports/  comparisons/   committed results
└── docker-compose.yml   the benchmark's Postgres
```

## The workload

`src/workload.ts` generates the same board every time: one project, 60
members (10 may edit, 50 only view) and 2,000 tasks spread over seven
statuses, each with a 4,096-byte `plan`. The first ten cards of each of the
six board columns are the 60 "on-screen" cards: every viewer subscribes to
them and every writer edits them. The runner writes it to
`results/workload.json` and each app's `src/seed.ts` loads exactly those rows.

## Scenarios

Every scenario connects its clients first (not measured), waits two seconds,
then measures one window from its first request until the server and every
client are idle again (or a cap is hit, which is reported).

| Scenario          | Clients               | Measured window                                                          |
| ----------------- | --------------------- | ------------------------------------------------------------------------ |
| `board-steady`    | 50 viewers, 5 writers | writers make 2 writes/s each for 60 s, open loop                         |
| `board-burst`     | 50 viewers, 5 writers | 100 writes spread over 2 s                                               |
| `reconnect-storm` | 190 viewers           | every viewer drops and reconnects within 2 s; each redoes its board load |
| `fat-read`        | 20 plain connections  | all 20 call `getTasksByStatus` in the same tick, 10 rounds               |

`--quick` shrinks them (10 viewers and 10 s for board-steady, 20 writes for
board-burst, 20 viewers for reconnect-storm, 5 clients and 3 rounds for
fat-read) for smoke runs only.

A 4.1 viewer reproduces on the wire what a 4.1 board page does with
`useCollection`, 60 `useSubscription`s and one `useServiceQuery`
(`src/drivers/v4/viewer.ts` lists the hook behaviors it copies: the
batcher's single `batchSubscribe`, the 100 ms `invalidateOn` debounce,
TanStack's refetch-while-fetching, the 10 s timeouts, one retry, and the
offline `unsubscribe`s sent on reconnect). A 5.0 viewer runs the 5.0 client
itself, as a board page with `useCollection`, `useEntities` and a watched
`useQuery` does (`src/drivers/v5/viewer.ts`): the client's connection, its
live data (one batched `qd:sub`, resume by revision after a reconnect), the
invalidation coordinator (at most one refetch per 250 ms window) and its
subscription lane, with only the query hook's glue reproduced on a TanStack
`QueryObserver`. Both send the same writes in the same order
(`src/drivers/writes.ts`); writers stamp each title with the time they sent
it, so viewers can time delivery.

## The 4.1 app

`apps/v4` depends on `@fitzzero/quickdraw-core` at exactly `4.1.0`, so bun
installs the published package rather than the workspace's 5.0 sources. It is
written the way the 4.1 README teaches:

- `createQuickdrawServer` with JWT auth and every other option at its default
  (method logging on, console logger). Its output goes to a log file.
- `ProjectService` checks access through the `ProjectMember` table (the
  README's "membership table" pattern); `TaskService` inherits it from the
  task's project in `checkEntryACL`, and leaves `batchSubscribe` on
  BaseService's defaults, which the README never asks an app to override.
- `TaskService` declares the `cardsByProject` collection (cards without the
  plan), a `getTasksByStatus` query returning full rows, 20 per column plus a
  count, as Conveyor's board does, and an `updateTask` mutation that writes
  through raw Prisma and then emits by hand (`emitUpdate` and
  `emitCollectionUpsert`), the pattern behind most real 4.1 writes.
- Prisma 7 with `new PrismaPg({ connectionString })`, so pg's default pool of
  10 connections.

Its sockets carry 15 listeners each (one per method and five per service,
plus Socket.IO's own; `server.listenersPerSocket` in a result), where
Conveyor registers about 800, so connection setup costs less here than in a
large app.

Nothing in `apps/v4` is built, linted, typechecked or tested by CI: it needs a
generated Prisma client, which CI does not create. Check it locally with
`bun run --cwd bench/apps/v4 check` (generates the client, confirms
`prisma/schema.sql` matches `schema.prisma`, typechecks). The runner creates
the tables from `prisma/schema.sql` with `psql` inside the container; after
changing `schema.prisma`, run `bun run --cwd bench/apps/v4 schema:sql`.

## The 5.0 app

`apps/v5` serves the same board on this workspace's `@fitzzero/quickdraw-core`
(`workspace:*`, so it runs on the built `packages/core/dist`), written the way
the 5.0 README teaches. Its schema, tables, seed and Prisma setup are the 4.1
app's, byte for byte (`src/apps.test.ts` checks it), so both serve identical
rows.

- Contracts in `src/contracts/` (what an app's shared package holds; the 5.0
  driver imports them as `bench-app-v5/contracts`): the task entity with its
  4 KB `plan`, a lean `card` projection, the `cardsByProject` collection
  (scoped by project, ordered by ordinal and id, with an index and two
  views), `getTasksByStatus` watching that collection, `updateTask`, and the
  read/write kit's `get`, `list` and `update`.
- `projectService` takes its access from `ProjectMember` (`members`);
  `taskService` inherits it from the task's project (`inherit`), anchors the
  collection on the project, shares the board query across callers
  (`share: "all"`), and writes with a plain `db.task.update` through the
  tracked client, so subscribers get the entity frame, the collection delta
  and the change signal without a hand-written emit.
- `qd.createServer` on an Express app with JWT auth and every option at its
  default, the socket rate limiter included: its 600 events per minute per
  socket cover this workload (a writer sends 120 writes a minute, a viewer
  reads the board at most 240 times), which 4.1 serves without any limiter.
  The 5.0.0 report's runs raised it to 1,000, because the default was 100
  then and refused part of the work (`reports/5.0.0.md`).
- `src/instrument.ts` reports the same fields as `apps/v4`, from the
  completion record each call produces (`onCall`), the Prisma client's query
  events, and a Socket.IO middleware that watches every frame; `src/harness.ts`
  serves the runner's routes.

Unlike `apps/v4`, it is linted (the 5.0 lint rules, with no disables) and
typechecked in CI: its `db:generate` script makes the Prisma client before
`typecheck`.

## Comparing two versions

`docs/benchmarks.md` has the rules. In one sitting, run the old target, the
new one with `--baseline --label <version>`, then the old one again, copy the
two old runs into `comparisons/<version>/`, and render the report:

```bash
bun run --filter bench compare -- --before comparisons/5.0.0/4.1.0-first.json \
  --after baselines/5.0.0.json --again comparisons/5.0.0/4.1.0-second.json --out reports/5.0.0.md
```

The report puts first every metric where the new version is worse than both
old runs, then every metric the two old runs disagree on by more than 10%,
then the targets, the analysis, and every metric of every scenario with the
three runs side by side. The analysis is written by hand in the report, and
rendering it again keeps it.

## Adding an app

An app under `apps/<name>` is driven by `--target <name>` if it keeps this
contract: `src/seed.ts <workload.json>` resets the database to the workload;
`src/server.ts` reads `PORT`, `DATABASE_URL` and `JWT_SECRET` and serves
`GET /health`, `GET /bench/info`, `GET /bench/tokens`, `GET /bench/metrics`
and `POST /bench/metrics/reset` with the same fields as `apps/v4`
(`src/instrument.ts`); `prisma/schema.sql` creates its tables; a `generate`
script prepares its client. Its results are filed under the
quickdraw-core version it installs, unless `--label` names another. An app on
a different wire protocol also needs its own driver under `src/drivers/`
(`types.ts` is what a scenario needs of it), added to `TARGETS`,
`src/drivers/index.ts` and `src/drivers/notes.ts`.
