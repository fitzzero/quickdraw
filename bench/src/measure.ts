import { monitorEventLoopDelay } from "node:perf_hooks";
import type { AppServer } from "./env/app";
import { watchNoise } from "./env/noise";
import type { Recorder } from "./recorder";
import type { LoadgenMetrics, Measurement, ServerMetrics } from "./scenarios";

const NS_PER_MS = 1e6;
/** The histogram records whole sampling intervals; delays are the lateness beyond one. */
const RESOLUTION_MS = 10;

function lateness(ns: number): number {
  return Number.isFinite(ns) ? Math.max(0, ns / NS_PER_MS - RESOLUTION_MS) : 0;
}

/** CPU and event-loop delay of the load generator itself, to show it was not the bottleneck. */
function startLoadgen(): { stop(): LoadgenMetrics } {
  const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  histogram.enable();
  const cpu = process.cpuUsage();
  return {
    stop: () => {
      histogram.disable();
      const used = process.cpuUsage(cpu);
      return {
        cpuSeconds: (used.user + used.system) / 1e6,
        eventLoopDelayP99Ms: lateness(histogram.percentile(99)),
        eventLoopDelayMaxMs: lateness(histogram.max),
      };
    },
  };
}

/** The cpus the server is pinned to, and every cpu the benchmark uses (server, load generator, Postgres). */
export interface CpuSets {
  server: number[];
  bench: number[];
}

/** Reset the server's counters, run the work, then collect client and server numbers. */
export async function measure(
  server: AppServer,
  recorder: Recorder,
  cpus: CpuSets,
  work: () => Promise<void>,
): Promise<Measurement> {
  await server.resetMetrics();
  const loadgen = startLoadgen();
  const noise = watchNoise(server.pid, cpus.server, cpus.bench);
  recorder.start();
  const startedAt = performance.now();
  await work();
  const windowMs = performance.now() - startedAt;
  const recorded = recorder.stop();
  const loadgenMetrics = loadgen.stop();
  const machineNoise = noise.stop();
  let metrics: ServerMetrics | null = null;
  let serverError: string | null = null;
  try {
    metrics = (await server.readMetrics()) as ServerMetrics;
  } catch (error) {
    const exit = server.exitStatus;
    serverError =
      exit === null
        ? `GET /bench/metrics failed: ${error instanceof Error ? error.message : String(error)}`
        : `the server process exited with code ${exit}`;
  }
  return {
    windowMs,
    server: metrics,
    serverError,
    loadgen: loadgenMetrics,
    noise: machineNoise,
    ...recorded,
  };
}

/** Handlers still running on the server, or null when it cannot answer. */
export async function serverInFlight(server: AppServer): Promise<number | null> {
  try {
    const metrics = (await server.readMetrics(5_000)) as ServerMetrics;
    return metrics.inFlight;
  } catch {
    return null;
  }
}
