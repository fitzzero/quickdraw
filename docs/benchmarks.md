# Benchmarks

quickdraw-core performance is measured with the harness in `bench/` (how to
run it: [bench/README.md](../bench/README.md)). A number is only quoted,
in a PR, a release note or an RFC, if it was measured under the rules below.
The harness is a release tool, not a CI gate.

The 4.1.0 baseline is `bench/baselines/4.1.0.json`, with the readable report
in `bench/reports/4.1.0.md`.

## Rules

1. **Equal CPU limits for every run.** The app server is pinned to the same
   cpus with the same method in every run that will be compared (by default
   `taskset -c 2,3`: two cores). The load generator and Postgres get cpus of
   their own (10,11 and 6-9 by default), so neither competes with the server.
   Every result file records the limits that were used.
2. **Baseline, change, baseline.** Compare versions on one machine in one
   sitting: run the old version, then the new one, then the old one again.
   If the two old runs disagree by more than their own spread, the machine was
   too noisy; rerun rather than compare. A baseline committed on another day
   is a reference point, not a replacement for the fresh old-version runs.
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
| Snapshots served                        | Collection snapshots and entity rows returned by subscribe calls                                                                             |
| Handler runs per method                 | Every method handler and subscription call, counted by wrapping the services from outside                                                    |
| Peak RSS                                | The server's resident memory, sampled every 250 ms                                                                                           |
| Load generator CPU and event-loop delay | To show the client side was not the bottleneck                                                                                               |

Each run starts a fresh server process on a freshly seeded database. Writes
are open loop: they go out on schedule whether or not earlier writes were
answered, so a slow server cannot lower the load it is offered.

## Comparing a new version

1. Add an app for the new version under `bench/apps/` that keeps the app
   contract in `bench/README.md`, serving the same board from the same
   workload file.
2. On the machine and cpus the baseline records, run the old app, the new
   app, then the old app again:
   `bun run --filter bench bench -- --app <name> --repetitions 3`.
3. Compare medians only where the matching rules hold, quote the failed
   requests with the latencies, and state the load average.
