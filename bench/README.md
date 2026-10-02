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
bun run --filter bench bench -- --scenario board-steady --quick   # smoke run, about 20 s
bun run --filter bench bench -- --repetitions 3                   # every scenario, 3 times each
bun run --filter bench bench -- --repetitions 3 --baseline        # also writes baselines/ + reports/
bun run --filter bench bench -- --help
```

The runner starts Postgres (`docker compose -p quickdraw-bench`, host port
5544, cpuset 6-9, data in tmpfs) if it is not already running, and stops it
again at the end if it started it (`--keep-db` leaves it up). It never
touches any other container. Each run of a scenario then reseeds the
database, starts a fresh app server pinned with `taskset -c 2,3`, drives it
from the runner's own process (pinned to cpus 10,11), and stops the server.
Pick other cpus or ports with `--server-cpus`, `--loadgen-cpus`, `--pg-cpus`,
`--port` and `--pg-port`; the result file records whatever was used.

Output:

| Path                       | What                                                                        | Committed |
| -------------------------- | --------------------------------------------------------------------------- | --------- |
| `baselines/<version>.json` | A `--baseline` run's full result                                            | yes       |
| `reports/<version>.md`     | The same run as a readable report                                           | yes       |
| `results/`                 | Every other run's JSON and report, server logs, the generated workload file | no        |
| `result.schema.json`       | JSON Schema for result files, generated from `src/result-schema.ts`         | yes       |

After changing `src/result-schema.ts`, run `bun run --filter bench schema`;
`src/report.test.ts` fails until the committed schema matches. After changing
how reports are written, re-render one from its JSON without rerunning
anything: `bun run --filter bench report -- baselines/4.1.0.json reports/4.1.0.md`.

## Layout

```
bench/
├── src/                 the runner (workspace package "bench")
│   ├── runner.ts        entry point; cli.ts parses options
│   ├── workload.ts      the board every app is seeded with (deterministic)
│   ├── scenarios/       board-steady, board-burst, reconnect-storm, fat-read
│   ├── drivers/v4/      4.1 wire protocol: viewer, writer, connection
│   ├── env/             Docker, the app server process, machine description
│   ├── report.ts        result JSON + Markdown; summary.ts does medians and spread
│   └── result-schema.ts the result file's schema
├── apps/v4/             the board app on the published @fitzzero/quickdraw-core 4.1.0
├── baselines/  reports/ committed results
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

A viewer reproduces on the wire what a 4.1 board page does with
`useCollection`, 60 `useSubscription`s and one `useServiceQuery`
(`src/drivers/v4/viewer.ts` lists the hook behaviors it copies: the
batcher's single `batchSubscribe`, the 100 ms `invalidateOn` debounce,
TanStack's refetch-while-fetching, the 10 s timeouts, one retry, and the
offline `unsubscribe`s sent on reconnect). Writers stamp each title with the
time they sent it, so viewers can time delivery.

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

It registers 13 socket listeners per connection, where Conveyor registers
about 800, so connection setup costs less here than in a large app.

Nothing in `apps/v4` is built, linted, typechecked or tested by CI: it needs a
generated Prisma client, which CI does not create. Check it locally with
`bun run --cwd bench/apps/v4 check` (generates the client, confirms
`prisma/schema.sql` matches `schema.prisma`, typechecks). The runner creates
the tables from `prisma/schema.sql` with `psql` inside the container; after
changing `schema.prisma`, run `bun run --cwd bench/apps/v4 schema:sql`.

## Adding an app

An app under `apps/<name>` is driven by `--app <name>` if it keeps this
contract: `src/seed.ts <workload.json>` resets the database to the workload;
`src/server.ts` reads `PORT`, `DATABASE_URL` and `JWT_SECRET` and serves
`GET /health`, `GET /bench/info`, `GET /bench/tokens`, `GET /bench/metrics`
and `POST /bench/metrics/reset` with the same fields as `apps/v4`
(`src/instrument.ts`); `prisma/schema.sql` creates its tables; a `generate`
script prepares its client. Its results are filed under the
quickdraw-core version it installs. An app on a different wire protocol also
needs its own driver next to `src/drivers/v4`.
