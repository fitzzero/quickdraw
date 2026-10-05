# Benchmarks

quickdraw-core performance is measured with the harness in `bench/` (how to
run it: [bench/README.md](../bench/README.md)). A number is only quoted,
in a PR, a release note or an RFC, if it was measured under the rules below.
The harness is a release tool, not a CI gate.

The 4.1.0 baseline is `bench/baselines/4.1.0.json`, with the readable report
in `bench/reports/4.1.0.md`. 5.0.0 was measured against 4.1.0 in one sitting
on the final code (5.0.0-rc.6, 2026-10-05): the report is
`bench/reports/5.0.0.md`, the 5.0 run `bench/baselines/5.0.0.json`, and the
two 4.1 runs around it `bench/comparisons/5.0.0/`. The first measurement, on
5.0.0-alpha.0 (2026-10-04), is in those files' git history. The headline
figures are below, in "5.0.0 against 4.1.0".

## Rules

1. **Equal CPU limits for every run.** The app server is pinned to the same
   cpus with the same method in every run that will be compared (by default
   `taskset -c 2,3`: two cores). The load generator and Postgres get cpus of
   their own (10,11 and 6-9 by default), so neither competes with the server.
   Use cpus on separate physical cores (on reaper0, a 12-core Ryzen 9 7900,
   cpus 2 and 3 are two cores whose SMT siblings are 14 and 15). Every result
   file records the limits that were used.
2. **Baseline, change, baseline.** Compare versions on one machine in one
   sitting: run the old version, then the new one, then the old one again.
   Where the two old runs disagree on a metric by more than 10% of their mean,
   the machine was too noisy for that metric: say so, and rerun rather than
   claim anything from it. A baseline committed on another day is a reference
   point, not a replacement for the fresh old-version runs.
3. **Three repetitions, median reported.** Each scenario runs three times,
   interleaved with the other scenarios so that noise spreads across them.
   Reports give the median of every metric and its spread (max minus min, as
   a percentage of the median).
4. **Failed requests are counted and shown.** Latency percentiles only cover
   calls answered successfully within the client's timeout, so every report
   shows next to them the calls that timed out, were answered with an error,
   or were still unanswered when the window closed. A faster p95 bought with
   more failures is not an improvement.
5. **No claim from unmatched runs.** Compare only results whose workload,
   scenario parameters, CPU limits, machine and runtime versions match; all
   of them are in the result file. `--quick` runs are smoke tests and are
   never compared with anything.
6. **Say how noisy the machine was.** Each run records the load average at
   its start, and every comparison states it. The pinned cores are not
   reserved: other processes on the machine can still run on them.

## What is measured

| Metric                                  | Where it comes from                                                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Client latency p50, p95, p99 per method | The load generator, from emit to acknowledgement, for calls answered successfully within the client's timeout                                |
| Delivery p50, p95, p99                  | From a writer emitting `updateTask` to a viewer receiving the change (collection delta, entity update), on the load generator's single clock |
| Failed requests                         | Timeouts, error answers and unanswered calls, per method                                                                                     |
| Server CPU seconds                      | `process.cpuUsage()` of the server process over the window                                                                                   |
| Event-loop delay p99 and max            | How late a 10 ms `perf_hooks.monitorEventLoopDelay` timer fired on the server (its histogram minus the 10 ms interval)                       |
| Bytes sent                              | TCP bytes the server wrote, including HTTP and WebSocket framing                                                                             |
| SQL statements                          | Prisma `query` events (Prisma merges `findUnique` calls made in the same tick into one statement)                                            |
| Snapshots served                        | Collection snapshots and entity rows returned by subscribe calls; 5.0's resumes and "not modified" rows are counted apart                    |
| Handler runs per method                 | Every method handler and subscription call: wrapped from outside in 4.1, from 5.0's completion records (a joined shared run is not a run)    |
| Listeners per socket                    | The most listeners any connected socket had when the window closed                                                                           |
| Peak RSS                                | The server's resident memory, sampled every 250 ms                                                                                           |
| Load generator CPU and event-loop delay | To show the client side was not the bottleneck                                                                                               |

Each run starts a fresh server process on a freshly seeded database. Writes
are open loop: they go out on schedule whether or not earlier writes were
answered, so a slow server cannot lower the load it is offered.

## Comparing a new version

1. Add an app for the new version under `bench/apps/` that keeps the app
   contract in `bench/README.md`, serving the same board from the same
   workload file, and a driver for its wire protocol under
   `bench/src/drivers/` when the protocol changed. The new app does the
   same work as the old one (same schema, seed, subscriptions, queries and
   writes) and is written the way its version's README teaches, not tuned
   for the benchmark.
2. On the machine and cpus the baseline records, in one sitting, run the old
   app, the new app, then the old app again, keeping the benchmark's
   Postgres up between runs:
   `bun run --filter bench bench -- --target <old> --repetitions 3 --keep-db`,
   then `--target <new> --repetitions 3 --baseline --label <version> --keep-db`,
   then the old one again; stop Postgres afterwards
   (`docker compose -f bench/docker-compose.yml -p quickdraw-bench down -v`).
3. Copy the two old runs into `bench/comparisons/<version>/` and render the
   report with `bun run --filter bench compare` (`bench/README.md`, "Comparing
   two versions", has the command). It refuses runs whose workload,
   parameters, limits, machine or runtime versions differ, and lists first
   every metric where the new version is worse than both old runs, then
   every metric the old runs disagree on by more than 10%.
4. Write the report's analysis section by hand (rendering again keeps it):
   why each worse metric is worse, and for each missed target a CPU profile
   of the server (`--cpu-prof` on a separate run) and a fix or a follow-up.
   Quote failed requests with the latencies, and state the load average.

## 5.0.0 against 4.1.0

Measured on `reaper0` on 2026-10-05 (4.1.0, then 5.0.0-rc.6, then 4.1.0
again, three repetitions of every scenario, the server on two cores). 4.1
is the mean of its two runs; no request failed in any run. The report
explains every row.

| Scenario        | Metric                             |    4.1 |    5.0 | 5.0 / 4.1                              |
| --------------- | ---------------------------------- | -----: | -----: | -------------------------------------- |
| board-steady    | board query p95 (ms)               |    122 |   19.0 | 0.15×                                  |
| board-steady    | `updateTask` p95 (ms)              |    120 |   13.8 | 0.12×                                  |
| board-steady    | server CPU per write (ms)          |   61.9 |   33.0 | 0.53×                                  |
| board-steady    | SQL statements per write           |    292 |    104 | 0.36×                                  |
| board-steady    | bytes sent per write (KB)          | 11,709 | 10,370 | 0.89× (target 0.30×: missed)           |
| board-steady    | event-loop delay p99 (ms)          |   8.55 |   6.83 | 0.80×                                  |
| board-burst     | board query p95 (ms)               |    156 |   73.6 | 0.47×                                  |
| board-burst     | server CPU (s)                     |   1.70 |   0.85 | 0.50×                                  |
| board-burst     | event-loop delay p99 (ms)          |   9.31 |   11.3 | 1.21×                                  |
| reconnect-storm | snapshots served                   | 11,590 |      0 | resumed by revision                    |
| reconnect-storm | live restore p50 (ms)              |   10.3 |   2.30 | 0.22×                                  |
| reconnect-storm | watched query restore p50 (ms)     |   10.4 |  1,056 | the 0 to 2 s refetch jitter, by design |
| reconnect-storm | peak RSS (MB)                      |    425 |    506 | 1.19× (not explained yet)              |
| fat-read        | board query handler runs per round |     20 |      1 | shared                                 |
| fat-read        | server CPU (s)                     |   0.94 |   0.39 | 0.41×                                  |
| fat-read        | event-loop delay p99 (ms)          |   3.36 |   8.82 | 2.6× (the 4.1 runs disagree by 25%)    |

Three of the four numeric targets are met (board query p95 at most half of
4.1, reconnect snapshots at most a tenth, one board query run per fat-read
round); bytes per write is missed because the benchmark app keeps a fat
board query that every viewer reads again after each write (`MIGRATION.md`,
"Boards", ports such a board to a collection).

## The template's game, 4.1 against 5.0

The quickdraw-chat template measures its game's netcode with a bench of its
own (its `docs/netcode-bench.md`, tier 1): one Node process runs the API
with the game loop, a seeded TCP latency proxy per bot, and bots that run
ports of the Godot client's prediction and interpolation and record every
frame they render. It was run on the template's 4.x tree (`main` at
`9011744`, quickdraw-core 4.1.0) and on its 5.0 tree (`dev` at `cc2f6de`,
5.0.0-rc.5) on `reaper0` on 2026-10-05, after the benchmark above and never
beside it: every scenario the bench lists, three 60 s runs per tree (the
first 5 s warm-up), one run per process, interleaved scenario by scenario.
Medians, with the spread of the three runs (max minus min) in brackets, for
`baseline-3p-100ms` (three players at about 100 ms round trip):

| baseline-3p-100ms                          | 4.x           | 5.0           |
| ------------------------------------------ | ------------- | ------------- |
| render latency (ms)                        | 117 (0)       | 117 (0)       |
| input acknowledgement round trip, p95 (ms) | 153 (0.5)     | 153 (0.8)     |
| divergence own vs remote, p95 (px)         | 65.6 (3.8)    | 65.2 (3.5)    |
| divergence remote vs remote, p95 (px)      | 0.07 (0.02)   | 0.08 (0.05)   |
| jerk, RMS                                  | 727 (84)      | 746 (64)      |
| teleports per minute                       | 0             | 0             |
| snapshot bytes, mean                       | 383 (3)       | 381 (4)       |
| server tick, p95 (ms)                      | 0.053 (0.007) | 0.045 (0.008) |
| event-loop delay of the process, p99 (ms)  | 1.24 (0.49)   | 1.18 (0.34)   |

The game's netcode is the same on 5.0. In all eight scenarios (among them
`asym-2p`, a player at about 150 ms round trip against one at 75, and
`bursty-3p`, with 250 ms stalls every 2 s), no metric a player sees (render
latency, input round trip, either divergence, jerk, teleports, hard snaps,
missed snapshots, trajectory error) differs by more than the spread of the
runs or the template bench's own floor, with one exception: jerk in
`bursty-3p` is 6% lower on 5.0 (1,132 against 1,208). The server's tick is
shorter on 5.0 in every scenario, by 3 to 20% (p95 0.038 to 0.053 ms
against 0.042 to 0.057), a few microseconds of a 50 ms tick and under the
bench's 0.05 ms floor. An earlier 20 s run at rc.3 against the template's
committed 4.x baseline showed own-vs-remote divergence 4.1% higher and
remote-vs-remote 23% lower; with three 60 s runs a tree, both are noise
(-0.6% and +15% here, each inside the spread and far under the floor),
while its unchanged render latency and input round trip hold.

Not measured: real browsers and the Godot WASM renderer (the bench's tier
2), bytes on the wire per frame (the scorecard counts a snapshot's JSON, not
its envelope), more than three players, NPCs (every scenario has none), and
real networks (the proxy delays TCP; it cannot reorder or drop). The
event-loop delay comes from a preload added for this comparison (a 10 ms
`monitorEventLoopDelay` over the whole process, server and bots together),
not from the template's scorecard. The 5.0 tree runs 5.0.0-rc.5, the version
the template pins; rc.6's changes (method replies reduced to their schema,
tracked writes, the JS client's outcomes and how it reads longer frames) are
not on the path a tick takes.

## Behind a cluster adapter

The harness runs one server; a cluster run (`--cluster 2`) is a follow-up.
What several nodes behind Valkey add is measured instead by the cluster test
projects (`bun run test:cluster` in `packages/core`) and kept in
`packages/core/test/e2e/__budgets__/budgets.cluster.ts.json` (both nodes'
statements and bytes, the same steps as `budgets.test.ts.json`):

| Step                           | One server (statements, bytes) | Two nodes behind Valkey |
| ------------------------------ | ------------------------------ | ----------------------- |
| One update with one subscriber | 8, 268                         | 9, 400                  |
| Subscribe to 60 tasks          | 4, 11,523                      | 4, 11,703               |
| First collection snapshot      | 5, 12,557                      | 5, 12,743               |
| Kit list, kit search           | unchanged                      | unchanged               |

The update costs one more statement (the writer reads every touched scope,
since other nodes' rooms are invisible to it) and more bytes (changes go out
whole). The subscribe steps cost the same on both: their extra bytes are the
three digits revisions gained in microseconds (sixteen instead of thirteen),
which the one-server file, measured in milliseconds, holds within its 5%
tolerance. Behind a cluster a flush that only removes (a delete, a move out
of a collection) reads the removed rows too, one statement per service and
collection, so a row created again meanwhile is not sent as removed. Besides
statements, every flush costs one Valkey round trip (the counter script)
before its first read, every subscription read one or two `GET`s, and a
flush that changes access waits for every node's answer, in line with the
node's other flushes: `docs/deploying.md`, "What it costs".
