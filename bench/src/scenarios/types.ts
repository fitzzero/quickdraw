import type { Driver } from "../drivers/types";
import type { MachineNoise } from "../env/noise";
import type { RecordedWindow, Recorder } from "../recorder";
import type { Workload } from "../workload";

export const SCENARIO_NAMES = [
  "board-steady",
  "board-burst",
  "reconnect-storm",
  "fat-read",
] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

/** What GET /bench/metrics returns: the server's own view of the window. */
export interface ServerMetrics {
  windowMs: number;
  cpuUserSeconds: number;
  cpuSystemSeconds: number;
  cpuSeconds: number;
  eventLoopDelayMs: { p50: number; p99: number; max: number; mean: number };
  bytesSent: number;
  bytesReceived: number;
  sqlStatements: number;
  snapshotsServed: {
    collection: number;
    collectionPages: number;
    entity: number;
    /** Collection subscriptions answered by a resume instead of a snapshot (5.0). */
    collectionResumes?: number;
    /** Entity subscriptions answered "not modified" instead of the row (5.0). */
    entityNotModified?: number;
  };
  handlerRuns: Record<string, number>;
  inFlight: number;
  rssPeakMb: number;
  connections: number;
  /** The most socket listeners any connected socket had; null with none connected. */
  listenersPerSocket?: number | null;
}

export interface LoadgenMetrics {
  cpuSeconds: number;
  eventLoopDelayP99Ms: number;
  eventLoopDelayMaxMs: number;
}

export interface Measurement extends RecordedWindow {
  windowMs: number;
  server: ServerMetrics | null;
  /** Why `server` is null, when it is. */
  serverError: string | null;
  loadgen: LoadgenMetrics;
  /** Other work on the machine during the window (null off Linux). */
  noise: MachineNoise | null;
}

export interface ScenarioContext {
  url: string;
  tokens: Record<string, string>;
  workload: Workload;
  recorder: Recorder;
  /** The client of the target under test. */
  driver: Driver;
  log(message: string): void;
  /** Reset the server's counters, run `work`, then read the client and server numbers. */
  measure(work: () => Promise<void>): Promise<Measurement>;
  /** Handlers the server is still running, or null when it does not answer. */
  serverInFlight(): Promise<number | null>;
}

export interface ScenarioRun {
  measurement: Measurement;
  /** False when the scenario hit one of its caps before finishing its work. */
  completed: boolean;
  outcome: string;
  metrics: Record<string, number | null>;
}

export interface Scenario<P extends Record<string, number> = Record<string, number>> {
  name: ScenarioName;
  description: string;
  parameters(quick: boolean): P;
  run(ctx: ScenarioContext, parameters: P): Promise<ScenarioRun>;
}
