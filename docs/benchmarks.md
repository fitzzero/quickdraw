# Benchmarks

quickdraw-core performance is measured with the harness in `bench/` (how to
run it: [bench/README.md](../bench/README.md)). A number is only quoted,
in a PR, a release note or an RFC, if it was measured under the rules below.
The harness is a release tool, not a CI gate.

The 4.1.0 baseline is `bench/baselines/4.1.0.json`, with the readable report
in `bench/reports/4.1.0.md`. 5.0.0 was measured against 4.1.0 in one sitting:
the report is `bench/reports/5.0.0.md`, the 5.0 run `bench/baselines/5.0.0.json`,
and the two 4.1 runs around it `bench/comparisons/5.0.0/`.

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

## Behind a cluster adapter

The harness runs one server; a cluster run (`--cluster 2`) is a follow-up.
What several nodes behind Valkey add is measured instead by the cluster test
projects (`bun run test:cluster` in `packages/core`) and kept in
`packages/core/test/e2e/__budgets__/budgets.cluster.ts.json` (both nodes'
statements and bytes, the same steps as `budgets.test.ts.json`):

| Step                           | One server (statements, bytes) | Two nodes behind Valkey |
| ------------------------------ | ------------------------------ | ----------------------- |
| One update with one subscriber | 8, 268                         | 9, 400                  |
| Subscribe to 60 tasks          | 4, 11,523                      | 4, 10,803               |
| First collection snapshot      | 5, 12,557                      | 5, 11,813               |
| Kit list, kit search           | unchanged                      | unchanged               |

The update costs one more statement (the writer reads every touched scope,
since other nodes' rooms are invisible to it) and more bytes (changes go out
whole). The subscribe steps send fewer bytes only because the test cluster's
counter starts at 0 (a revision of one digit instead of thirteen). Besides
statements, every flush costs one Valkey round trip (the counter script)
before its first read, every subscription read one or two `GET`s, and a flush
that changes access waits for every node's answer: `docs/deploying.md`, "What
it costs".
