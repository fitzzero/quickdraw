// The event-loop stall watchdog (`createServer({ stallWatchdog })`). A server
// whose event loop is blocked (a long synchronous loop, a huge
// `JSON.stringify`, synchronous crypto) answers nobody until it is free
// again, and nothing in a call's own record says so. The watchdog samples the
// loop's delay with Node's histogram (`perf_hooks.monitorEventLoopDelay`) at
// a 20 ms resolution, reads it every 10 s, and logs a warning when the 99th
// percentile delay of that window is above the threshold (200 ms), naming
// the window's slowest methods from the calls' completion records.
//
// Cost: the histogram is one libuv timer firing every 20 ms, and the read is
// one timer every 10 s; recording a call is one map update. A watchdog that
// samples much more finely becomes a load of its own, which is why the
// resolution is fixed. On an idle process it costs about 5 ms of CPU per
// 10 s, 0.05% of one CPU (`scripts/stall-watchdog-overhead.mjs`).
//
// A percentile needs repeated stalls to move: at the default window one
// 300 ms block is one sample of about 500, and the 99th percentile stays
// low. The warning is about a loop that keeps stalling, not one slow tick.

import { monitorEventLoopDelay, type ELDHistogram } from "node:perf_hooks";
import type { Logger } from "../../contract/logger";
import type { CallRecord } from "../pipeline/metrics";

/** The histogram's sampling resolution, in milliseconds. Fixed: finer sampling costs CPU. */
export const STALL_RESOLUTION_MS = 20;

/** The default threshold for the window's 99th percentile delay, in milliseconds. */
export const DEFAULT_STALL_THRESHOLD_MS = 200;

/** The default window: how often the delay is read, in milliseconds. */
export const DEFAULT_STALL_INTERVAL_MS = 10_000;

/** The shortest window the watchdog accepts, in milliseconds. */
export const MIN_STALL_INTERVAL_MS = 1_000;

const DEFAULT_SLOWEST = 5;

const MAX_INTERVAL_MS = 2_147_483_647;

/** Options of `createServer({ stallWatchdog })`. */
export interface StallWatchdogOptions {
  /** Warn when the window's 99th percentile event-loop delay is above this, in milliseconds. Default 200. */
  readonly thresholdMs?: number;
  /** How often the delay is read and a new window starts, in milliseconds; at least 1,000. Default 10,000. */
  readonly intervalMs?: number;
  /** How many of the window's slowest methods a warning names. Default 5. */
  readonly slowest?: number;
}

/** One method among a window's slowest, by its slowest call. */
export interface SlowMethod {
  /** `"taskService.list"`. */
  readonly method: string;
  readonly calls: number;
  readonly maxMs: number;
  readonly meanMs: number;
}

/** What one read of the window found. */
export interface StallReport {
  /** How long the window ran, in milliseconds. */
  readonly windowMs: number;
  /** The event loop's delays over the window, in milliseconds; 0 when nothing was sampled. */
  readonly p50Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
  /** True when `p99Ms` was above the threshold, and so a warning was logged. */
  readonly stalled: boolean;
  /** The window's slowest methods, slowest first. */
  readonly slowest: readonly SlowMethod[];
}

/** A running watchdog. */
export interface StallWatchdog {
  /** Counts one call of the window: give it every completion record (the dispatcher's `onCall`). */
  observe(record: CallRecord): void;
  /** Reads the window, starts a new one, and logs a warning when the window stalled. Its timer calls it. */
  check(): StallReport;
  /** Stops sampling and reading. */
  stop(): void;
}

interface MethodWindow {
  calls: number;
  maxMs: number;
  totalMs: number;
}

interface Settings {
  readonly thresholdMs: number;
  readonly intervalMs: number;
  readonly slowest: number;
}

function fail(message: string): never {
  throw new TypeError(`createServer: stallWatchdog.${message}`);
}

/** The watchdog's settings from `createServer`'s option; `undefined` when it is off. */
export function stallWatchdogSettings(
  option: boolean | StallWatchdogOptions | undefined,
): Settings | undefined {
  if (option === undefined || option === false) {
    return undefined;
  }
  const given: StallWatchdogOptions = option === true ? {} : option;
  if (typeof given !== "object" || given === null) {
    throw new TypeError("createServer: stallWatchdog must be true, false or its options");
  }
  const thresholdMs = given.thresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  const intervalMs = given.intervalMs ?? DEFAULT_STALL_INTERVAL_MS;
  const slowest = given.slowest ?? DEFAULT_SLOWEST;
  if (!(Number.isFinite(thresholdMs) && thresholdMs > 0)) {
    fail("thresholdMs must be a positive number of milliseconds");
  }
  if (
    !(
      Number.isSafeInteger(intervalMs) &&
      intervalMs >= MIN_STALL_INTERVAL_MS &&
      intervalMs <= MAX_INTERVAL_MS
    )
  ) {
    fail(`intervalMs must be a whole number of milliseconds, at least ${MIN_STALL_INTERVAL_MS}`);
  }
  if (!(Number.isSafeInteger(slowest) && slowest >= 0)) {
    fail("slowest must be a whole number, 0 or more");
  }
  return { thresholdMs, intervalMs, slowest };
}

const NS_PER_MS = 1e6;

function toMs(nanoseconds: number): number {
  return Math.round((nanoseconds / NS_PER_MS) * 10) / 10;
}

function rank(methods: ReadonlyMap<string, MethodWindow>, slowest: number): SlowMethod[] {
  return [...methods]
    .map(([method, window]) => ({
      method,
      calls: window.calls,
      maxMs: Math.round(window.maxMs),
      meanMs: Math.round(window.totalMs / window.calls),
    }))
    .sort((a, b) => b.maxMs - a.maxMs)
    .slice(0, slowest);
}

/** Reads `histogram` for the window that started at `startedAt`. */
function readWindow(
  histogram: ELDHistogram,
  startedAt: number,
): Omit<StallReport, "stalled" | "slowest"> {
  const windowMs = Math.round(performance.now() - startedAt);
  if (histogram.count === 0) {
    return { windowMs, p50Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0 };
  }
  return {
    windowMs,
    p50Ms: toMs(histogram.percentile(50)),
    p99Ms: toMs(histogram.percentile(99)),
    maxMs: toMs(histogram.max),
    meanMs: toMs(histogram.mean),
  };
}

/**
 * Starts sampling the event loop's delay, reading it every `intervalMs`. The
 * timer does not keep the process alive. `createServer({ stallWatchdog })`
 * starts one and stops it on `close()`.
 */
export function startStallWatchdog(settings: Settings, logger: Logger): StallWatchdog {
  const histogram = monitorEventLoopDelay({ resolution: STALL_RESOLUTION_MS });
  const methods = new Map<string, MethodWindow>();
  let startedAt = performance.now();
  histogram.enable();
  const check = (): StallReport => {
    const read = readWindow(histogram, startedAt);
    const slowest = rank(methods, settings.slowest);
    histogram.reset();
    methods.clear();
    startedAt = performance.now();
    const stalled = read.p99Ms > settings.thresholdMs;
    if (stalled) {
      logger.warn(
        `The event loop stalled: its 99th percentile delay was ${read.p99Ms} ms over the last ${read.windowMs} ms (threshold ${settings.thresholdMs} ms)`,
        { category: "quickdraw.stall", ...read, thresholdMs: settings.thresholdMs, slowest },
      );
    }
    return { ...read, stalled, slowest };
  };
  const timer = setInterval(check, settings.intervalMs);
  timer.unref();
  return {
    observe(record) {
      // A method that does not exist is named by the client: never a key.
      if (record.kind === undefined) {
        return;
      }
      const key = `${record.service}.${record.method}`;
      const window = methods.get(key);
      if (window === undefined) {
        methods.set(key, { calls: 1, maxMs: record.durationMs, totalMs: record.durationMs });
        return;
      }
      window.calls += 1;
      window.totalMs += record.durationMs;
      window.maxMs = Math.max(window.maxMs, record.durationMs);
    },
    check,
    stop() {
      clearInterval(timer);
      histogram.disable();
    },
  };
}
