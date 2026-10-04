// The parts of `createServer` that outlive one call (RFC 0003 section 3): the
// calls in flight `close()` waits for, the one shutdown however often
// `close()` is called, the opt-in signal handlers, and the opt-in event-loop
// stall watchdog (`observability/stallWatchdog.ts`).

import type { Server as HttpServer } from "node:http";
import type { Logger } from "../contract/logger";
import {
  callerGrantsOf,
  createCaller,
  setCallerGrants,
  type Caller,
  type CallerGrants,
} from "./caller";
import { DEFAULT_CLUSTER_TIMEOUT_MS, within } from "./cluster/acks";
import type { ContractOfServices, Dispatcher, PrincipalOfServices } from "./dispatcher";
import {
  stallWatchdogSettings,
  startStallWatchdog,
  type StallWatchdog,
  type StallWatchdogOptions,
} from "./observability/stallWatchdog";
import type { CallRecord } from "./pipeline/metrics";
import type { AnyService } from "./service";
import type { SocketServer } from "./transports/socketServer";

export type { StallWatchdogOptions };

/** Watches `SIGTERM` and `SIGINT` until the server closes; returns the function that stops watching. */
export function watchSignals(close: () => Promise<void>, logger: Logger): () => void {
  const onSignal = (signal: NodeJS.Signals): void => {
    logger.info(`Received ${signal}; closing the quickdraw server`, {
      category: "quickdraw.server",
    });
    close().catch((error: unknown) => {
      logger.error("Closing the quickdraw server failed", {
        category: "quickdraw.server",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  return () => {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  };
}

/** A dispatcher whose calls in flight can be awaited. */
export interface TrackedDispatcher<S extends readonly AnyService[]> {
  readonly dispatcher: Dispatcher<S>;
  /** Resolves once no call is in flight. */
  idle(): Promise<void>;
  /**
   * Makes the in-process callers of both dispatchers, the tracked one and
   * the one it wraps (and `qd.caller` through either), load the grants of a
   * principal that carries none through `grants`.
   */
  loadGrantsWith(grants: CallerGrants): void;
}

/**
 * Counts the calls in flight through `dispatcher`, the transports' and the
 * in-process caller's alike, so `close()` can wait for them. Its caller loads
 * grants once `loadGrantsWith` gave it where from.
 */
export function trackCalls<S extends readonly AnyService[]>(
  dispatcher: Dispatcher<S>,
): TrackedDispatcher<S> {
  const running = new Set<Promise<unknown>>();
  const call: Dispatcher<S>["call"] = (request) => {
    const result = dispatcher.call(request);
    running.add(result);
    const done = (): void => {
      running.delete(result);
    };
    void result.then(done, done);
    return result;
  };
  const tracked: Dispatcher<S> = Object.freeze({
    ...dispatcher,
    call,
    caller: (principal: PrincipalOfServices<S> | null) =>
      createCaller(() => call, principal, {
        grants: () => callerGrantsOf(tracked),
      }) as Caller<ContractOfServices<S>>,
  });
  return {
    dispatcher: tracked,
    async idle() {
      while (running.size > 0) {
        await Promise.allSettled([...running]);
      }
    },
    loadGrantsWith(grants) {
      setCallerGrants(tracked, grants);
      setCallerGrants(dispatcher, grants);
    },
  };
}

/** The server's `close`, and what else stops when it runs. */
export interface Closer {
  /** One shutdown, however often it is called. */
  readonly close: () => Promise<void>;
  /** Adds something to stop as the shutdown starts: the signal handlers, the watchdog. */
  readonly onClose: (stop: () => void) => void;
}

/** What a closing server lets settle before Socket.IO closes: the work its sockets' last events start. */
export interface Departure {
  /** Resolves once the live data's work in flight settled (a room's presence read from every node). */
  readonly drain: () => Promise<void>;
  /** How long it is waited for at most: `cluster.timeoutMs`. Default 1,000. */
  readonly timeoutMs?: number;
}

/** The server's `close`: one shutdown, however often it is called. */
export function closer(
  sockets: SocketServer,
  httpServer: HttpServer,
  idle: () => Promise<void>,
  timeoutMs: number,
  departure?: Departure,
): Closer {
  let closing: Promise<void> | undefined;
  const stops: (() => void)[] = [];
  const shutdown = async (): Promise<void> => {
    for (const stop of stops) {
      stop();
    }
    let expire = (): void => undefined;
    const expired = new Promise<void>((resolve) => {
      expire = resolve;
    });
    const timer = setTimeout(() => {
      httpServer.closeAllConnections();
      expire();
    }, timeoutMs);
    try {
      // This node's sockets go first, while a cluster adapter still reaches the
      // other nodes: each app room a socket was in asks them whether its user
      // is still there and tells them it left, which settles (bounded) before
      // the adapter closes, instead of waiting out its `requestsTimeout`. Each
      // socket's connection is closed, as `io.close()` closes them, rather than
      // disconnected: a client told "io server disconnect" would not reconnect
      // (to another node, in a rolling deploy).
      for (const socket of sockets.io.sockets.sockets.values()) {
        socket.conn.close();
      }
      if (departure !== undefined) {
        const bound = departure.timeoutMs ?? DEFAULT_CLUSTER_TIMEOUT_MS;
        await within(departure.drain(), bound).catch(() => undefined);
      }
      // Closes `httpServer` once its requests end, while the calls still
      // running finish: a mutation runs to its end.
      await Promise.all([sockets.io.close(), Promise.race([idle(), expired])]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    close: () => (closing ??= shutdown()),
    onClose: (stop) => {
      stops.push(stop);
    },
  };
}

/** The stall watchdog `createServer({ stallWatchdog })` asked for, wired to the dispatcher's records. */
export interface ServerWatchdog<O> {
  /** `options` with an `onCall` that gives the watchdog every record first, then the app's `onCall`. */
  readonly options: O;
  /** Starts sampling, once the server is built; `undefined` when the watchdog is off. */
  readonly start: ((logger: Logger) => StallWatchdog) | undefined;
}

/**
 * Checks the `stallWatchdog` option at once (a bad one throws before anything
 * starts) and routes the completion records to the watchdog started later.
 */
export function prepareWatchdog<O extends { readonly onCall?: (record: CallRecord) => void }>(
  options: O,
  option: boolean | StallWatchdogOptions | undefined,
): ServerWatchdog<O> {
  const settings = stallWatchdogSettings(option);
  if (settings === undefined) {
    return { options, start: undefined };
  }
  let watchdog: StallWatchdog | undefined;
  const { onCall } = options;
  return {
    options: {
      ...options,
      onCall: (record: CallRecord) => {
        watchdog?.observe(record);
        onCall?.(record);
      },
    },
    start: (logger) => {
      watchdog = startStallWatchdog(settings, logger);
      return watchdog;
    },
  };
}
