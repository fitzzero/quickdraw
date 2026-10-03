// The flush (RFC 0003 section 5.3): once a handler has settled and its
// response was sent, its unit of work merges the recorded writes per row,
// takes one revision, and hands the batch to the dispatcher's sinks in the
// order they were given. A sink that throws is logged with the rows it
// failed on; every other sink then hears about it through `onFlushError`.
// Nothing here rejects: the caller's response was already sent.
//
// A dispatcher runs its flushes one after another, in revision order
// (`inRevisionOrder`): a flush's sinks run once every flush with a lower
// revision has finished its own, so frames leave in revision order and a
// client that merges a patch only "when rev is newer" never drops one.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Logger } from "../../contract/logger";
import { describeError } from "../pipeline/metrics";
import { nextRev } from "../rev";
import { noFlushSink, type FlushInfo, type FlushSink } from "./flushSink";
import { mergeRecords } from "./records";
import type { UnitOfWorkScope, WriteRecord } from "./types";

/** How many rows a failure's log entry names. */
const LOGGED_ROWS = 20;

function logFailure(
  logger: Logger,
  message: string,
  writes: readonly WriteRecord[],
  info: FlushInfo,
  error: unknown,
): void {
  logger.error(message, {
    category: "quickdraw.flush",
    requestId: info.requestId,
    service: info.service,
    method: info.method,
    rev: info.rev,
    rowCount: writes.length,
    rows: writes.slice(0, LOGGED_ROWS).map((write) => `${write.op} ${write.model} ${write.id}`),
    error: describeError(error),
  });
}

/**
 * Merges `records`, takes one revision and hands the batch to `scope.sink`.
 * With nothing recorded, or nothing left once merged (rows the unit created
 * and deleted again), no revision is taken and the sink is not called.
 * Never rejects; a sink's failure is logged.
 */
export async function flushWrites(
  records: readonly WriteRecord[],
  scope: UnitOfWorkScope,
  logger: Logger,
): Promise<void> {
  const writes = mergeRecords(records);
  if (writes.length === 0) {
    return;
  }
  const { sink, ...origin } = scope;
  const info: FlushInfo = { ...origin, rev: nextRev() };
  try {
    await sink.flush(writes, info);
  } catch (error) {
    logFailure(
      logger,
      "Flushing writes failed; the response was already sent",
      writes,
      info,
      error,
    );
  }
}

interface Failure {
  readonly sink: FlushSink;
  readonly error: unknown;
}

/** Tells every sink but the one that failed, after all of them ran. */
async function reportFailures(
  sinks: readonly FlushSink[],
  failures: readonly Failure[],
  writes: readonly WriteRecord[],
  info: FlushInfo,
  logger: Logger,
): Promise<void> {
  for (const sink of sinks) {
    const failure = failures.find((candidate) => candidate.sink !== sink);
    if (failure === undefined || sink.onFlushError === undefined) {
      continue;
    }
    try {
      await sink.onFlushError(writes, info, failure.error);
    } catch (error) {
      logFailure(
        logger,
        "A flush sink failed to handle another sink's failure",
        writes,
        info,
        error,
      );
    }
  }
}

/**
 * A sink that runs the flushes it receives one at a time, in the order they
 * arrive, which is revision order: `flushWrites` takes a flush's revision
 * and hands the batch over in one synchronous step. A flush waits until the
 * flush before it has finished every sink; one that fails does not hold up
 * the next. A flush started from inside one of these runs (a sink that
 * writes through `qd.run`) runs at once instead: waiting for the run that
 * started it would never end.
 */
export function inRevisionOrder(sink: FlushSink): FlushSink {
  const running = new AsyncLocalStorage<true>();
  let last: Promise<void> = Promise.resolve();
  return Object.freeze({
    flush(writes: readonly WriteRecord[], info: FlushInfo): Promise<void> {
      if (running.getStore() === true) {
        return sink.flush(writes, info);
      }
      const run = last.then(() => running.run(true, () => sink.flush(writes, info)));
      last = run.catch(() => undefined);
      return run;
    },
  });
}

/**
 * One sink made of several: each batch goes to every sink in order, a sink
 * that throws is logged and the others still run, and once all have run
 * every sink but a failed one receives `onFlushError`. It never rejects. A
 * lone sink is returned as it is, and no sinks make one that does nothing.
 */
export function combineSinks(sinks: readonly FlushSink[], logger: Logger): FlushSink {
  const all = [...sinks];
  if (all.length === 0) {
    return noFlushSink;
  }
  if (all.length === 1 && all[0] !== undefined) {
    return all[0];
  }
  return Object.freeze({
    async flush(writes: readonly WriteRecord[], info: FlushInfo): Promise<void> {
      const failures: Failure[] = [];
      for (const sink of all) {
        try {
          await sink.flush(writes, info);
        } catch (error) {
          failures.push({ sink, error });
          logFailure(
            logger,
            "A flush sink failed; the response was already sent",
            writes,
            info,
            error,
          );
        }
      }
      if (failures.length > 0) {
        await reportFailures(all, failures, writes, info, logger);
      }
    },
  });
}
