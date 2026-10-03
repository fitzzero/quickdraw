// The parts of `createServer` that outlive one call (RFC 0003 section 3): the
// calls in flight `close()` waits for, the one shutdown however often
// `close()` is called, the opt-in signal handlers, and the opt-in event-loop
// stall watchdog (`observability/stallWatchdog.ts`).

import type { Server as HttpServer } from "node:http";
import type { Logger } from "../contract/logger";
import { createCaller, type Caller } from "./caller";
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
}

/**
 * Counts the calls in flight through `dispatcher`, the transports' and the
 * in-process caller's alike, so `close()` can wait for them.
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
  return {
    dispatcher: Object.freeze({
      ...dispatcher,
      call,
      caller: (principal: PrincipalOfServices<S> | null) =>
        createCaller(() => call, principal) as Caller<ContractOfServices<S>>,
    }),
    async idle() {
      while (running.size > 0) {
        await Promise.allSettled([...running]);
      }
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

/** The server's `close`: one shutdown, however often it is called. */
export function closer(
  sockets: SocketServer,
  httpServer: HttpServer,
  idle: () => Promise<void>,
  timeoutMs: number,
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
      // Disconnects every socket and closes `httpServer` once its requests
      // end, while the calls still running finish: a mutation runs to its end.
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
