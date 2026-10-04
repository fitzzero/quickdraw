// Development warnings for a client caught in a loop, in the server's format
// (`[quickdraw:<kind>] <service>.<method>: <message>`, RFC 0003 section 13):
//
// - `repeated-mutation`: one `useMutation` hook instance issues its mutation
//   more than 5 times within a second, as a mutation fired from an effect or
//   from render does. The warning names the component that holds the hook.
// - `repeated-invalidation`: one cached query is asked to be invalidated
//   with `qd.invalidate` more than 20 times within a second, as an effect or
//   a render that invalidates on every run does; or the coordinator itself
//   refetches it or marks it stale more than 20 times within a second. The
//   coordinator's work is counted after its coalescing, at the refetch it
//   issues: its window turns a watched topic that changes 25 times a second
//   into a few refetches, which is the coordinator doing its job, not a loop.
//
// The coordinator keeps a loop from flooding the server (one read in flight
// per key, one queued, one refetch per window), so an app's loop would
// otherwise go unseen until the socket's rate limit answers `RATE_LIMITED`;
// that is why what an app asks is counted as it is asked. Each warning is
// logged once per kind and member per `QueryClient`, with the root's
// `consoleLogger`, and only in development: never where
// `process.env.NODE_ENV` is "production" or cannot be read.
//
// React-free: the hooks hand in a trace of where they were rendered, made
// once per hook instance in development, whose stack names the component
// (the frame just above React's own `react_stack_bottom_frame`).

import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { consoleLogger } from "../contract/logger";
import { KEY_ROOT } from "./keys";

/** Mutations one hook instance may issue within {@link MUTATION_WINDOW_MS}. */
export const MUTATION_LIMIT = 5;
export const MUTATION_WINDOW_MS = 1_000;

/**
 * Invalidations one cached query may be asked for, and refetches (or stale
 * marks) the coordinator may issue for it, within {@link INVALIDATION_WINDOW_MS}.
 */
export const INVALIDATION_LIMIT = 20;
export const INVALIDATION_WINDOW_MS = 1_000;

/** How many queries' times a guard keeps per count; the least recently counted go first. */
const MAX_QUERIES = 1_000;

/** What one mutation hook instance counts: when it mutated, and where it was rendered. */
export interface MutationTrace {
  readonly times: number[];
  /** An error made where the hook was first rendered, for its stack; `undefined` outside development. */
  readonly origin: Error | undefined;
}

/** The loop warnings of one `QueryClient`. */
export interface LoopGuard {
  /** Counts one mutation `trace`'s hook instance issued, of `service.method`. */
  mutated(trace: MutationTrace, service: string, method: string): void;
  /** Counts one invalidation an app asked for (`qd.invalidate`) of the cached query `queryKey` (hashed `queryHash`). */
  asked(queryKey: QueryKey, queryHash: string): void;
  /** Counts one refetch or stale mark the coordinator issued for the cached query, after coalescing. */
  issued(queryKey: QueryKey, queryHash: string): void;
}

/** True in development: `process.env.NODE_ENV` can be read and is not "production". */
export function isDevelopment(): boolean {
  try {
    // Written out whole, so a bundler can inline it.
    return process.env.NODE_ENV !== "production";
  } catch {
    // No `process` here (a bundler that provides none): treated as production.
    return false;
  }
}

/** How many stack frames a trace keeps, where the engine lets it say (V8): enough for wrapping hooks. */
const TRACE_FRAMES = 40;

/**
 * A hook instance's trace, made where it is first rendered (call it from the
 * hook itself, so its component is a few frames up): the origin only in
 * development.
 */
export function createMutationTrace(): MutationTrace {
  if (!isDevelopment()) {
    return { times: [], origin: undefined };
  }
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = Math.max(limit, TRACE_FRAMES);
  const origin = new Error("quickdraw: rendered here");
  Error.stackTraceLimit = limit;
  return { times: [], origin };
}

const BOTTOM_FRAME = /react[-_]stack[-_]bottom[-_]frame/u;

/** The function a stack frame is in: `at TaskEditor (...)` (V8) or `TaskEditor@...` (Firefox, Safari). */
function frameName(frame: string): string | undefined {
  const name = /^\s*at (?:async )?([^\s(]+)/u.exec(frame)?.[1] ?? /^([^@\s]+)@/u.exec(frame)?.[1];
  const bare = name?.replace(/^Object\./u, "");
  return bare === undefined || bare === "<anonymous>" || bare === "" ? undefined : bare;
}

/**
 * The component a trace was made in: the frame just above React's
 * `react_stack_bottom_frame`, which calls every function component in
 * development builds; `undefined` when the stack does not say.
 */
export function componentOf(origin: Error | undefined): string | undefined {
  const frames = origin?.stack?.split("\n") ?? [];
  const bottom = frames.findIndex((frame) => BOTTOM_FRAME.test(frame));
  return bottom > 0 ? frameName(frames[bottom - 1] ?? "") : undefined;
}

/** Records one event at `at` in `times`, and says whether more than `limit` fell within `windowMs`. */
function crossed(times: number[], at: number, limit: number, windowMs: number): boolean {
  times.push(at);
  while (times.length > 0 && at - (times[0] ?? at) >= windowMs) {
    times.shift();
  }
  if (times.length > limit + 1) {
    times.shift();
  }
  return times.length > limit;
}

/** `service.method` for a quickdraw method key, else the key as JSON. */
function memberOf(queryKey: QueryKey): string {
  const [root, service, kind, method] = queryKey;
  if (root === KEY_ROOT && kind === "m" && typeof service === "string") {
    return `${service}.${String(method)}`;
  }
  return JSON.stringify(queryKey).slice(0, 120);
}

const OFF: LoopGuard = Object.freeze({
  mutated: () => undefined,
  asked: () => undefined,
  issued: () => undefined,
});

/** The times kept for `queryHash` in `counts`, most recently counted last; at most {@link MAX_QUERIES} queries. */
function timesOf(counts: Map<string, number[]>, queryHash: string): number[] {
  const times = counts.get(queryHash) ?? [];
  counts.delete(queryHash);
  counts.set(queryHash, times);
  if (counts.size > MAX_QUERIES) {
    const [oldest] = counts.keys();
    counts.delete(oldest ?? queryHash);
  }
  return times;
}

/** A loop guard: counts, and logs each kind of warning once per member. */
export function createLoopGuard(now: () => number = Date.now): LoopGuard {
  const warned = new Set<string>();
  const asked = new Map<string, number[]>();
  const issued = new Map<string, number[]>();
  const warn = (kind: string, member: string, message: string): void => {
    const key = `${kind}\u0000${member}`;
    if (!warned.has(key)) {
      warned.add(key);
      consoleLogger.warn(`[quickdraw:${kind}] ${member}: ${message}`, {
        category: "quickdraw.dev",
        warning: kind,
      });
    }
  };
  const invalidated = (counts: Map<string, number[]>, queryKey: QueryKey, hash: string): void => {
    const times = timesOf(counts, hash);
    if (!crossed(times, now(), INVALIDATION_LIMIT, INVALIDATION_WINDOW_MS)) {
      return;
    }
    warn(
      "repeated-invalidation",
      memberOf(queryKey),
      `invalidated ${String(times.length)} times within a second: an effect or a render that invalidates it on every run loops with the read it causes. ` +
        "Invalidate from an event handler or once a mutation settles; a scope that changes this often reads better as a collection",
    );
  };
  return Object.freeze({
    mutated(trace: MutationTrace, service: string, method: string): void {
      if (!crossed(trace.times, now(), MUTATION_LIMIT, MUTATION_WINDOW_MS)) {
        return;
      }
      const component = componentOf(trace.origin);
      warn(
        "repeated-mutation",
        `${service}.${method}`,
        `mutated ${String(trace.times.length)} times within a second by one useMutation` +
          `${component === undefined ? "" : ` (in ${component})`}: a mutation fired from an effect or from render repeats like this, and each one writes. ` +
          "Fire it from an event handler, or guard the effect so it runs once per change",
      );
    },
    asked(queryKey: QueryKey, queryHash: string): void {
      invalidated(asked, queryKey, queryHash);
    },
    issued(queryKey: QueryKey, queryHash: string): void {
      invalidated(issued, queryKey, queryHash);
    },
  });
}

const guards = new WeakMap<QueryClient, LoopGuard>();

/** The loop guard of `queryClient`, made on first use; one that does nothing outside development. */
export function loopGuardOf(queryClient: QueryClient): LoopGuard {
  let guard = guards.get(queryClient);
  if (guard === undefined) {
    guard = isDevelopment() ? createLoopGuard() : OFF;
    guards.set(queryClient, guard);
  }
  return guard;
}
