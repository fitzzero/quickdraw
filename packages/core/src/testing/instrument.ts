// What `createTestApp` adds to the server it boots, besides the frame
// recorder (`frames.ts`): strict development warnings when asked, the
// counters `expectBudget` measures a step with (`budget.ts`: the calls'
// completion records, the tracked client's statements, the bytes written to
// sockets), and an in-process caller that reports its replies' size.

import { consoleLogger, type Logger } from "../contract/logger";
import { utf8ByteLength } from "../protocol/utf8";
import { createCaller } from "../server/caller";
import { STRICT_WARNINGS } from "../server/devWarnings";
import type { CallRecord } from "../server/pipeline/metrics";
import { toCallReply, type DispatchRequest, type DispatchResult } from "../server/pipeline/request";
import { storageOf, type StorageAdapter } from "../server/storage";
import type { QuickdrawIo } from "../server/transports/types";
import { statementsIssued } from "../server/uow/unitOfWork";
import { addBudgetSource, recordBudgetCall } from "./budget";

/** The test app's default logger: warnings and errors only. */
export const quietLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message, meta) => consoleLogger.warn(message, meta),
  error: (message, meta) => consoleLogger.error(message, meta),
  child: () => quietLogger,
};

/** The options of `createTestApp` this module reads. */
export interface InstrumentedOptions {
  readonly onCall?: (record: CallRecord) => void;
  /**
   * Under vitest (`VITEST` set), throw every development warning (N+1
   * statements, unbounded reads, oversized replies, untracked writes) as a
   * `DevWarningError` where it is raised, so the test that caused it fails.
   * Default `false`: warnings are logged once.
   */
  readonly strictWarnings?: boolean;
}

/**
 * `options` for `createServer`: `strictWarnings` turned into the dispatcher's
 * hidden strict flag, and an `onCall` that also hands every record to the
 * step `expectBudget` is measuring.
 */
export function instrumentOptions<O extends InstrumentedOptions>(
  options: O,
): Omit<O, "strictWarnings"> {
  const { strictWarnings, onCall, ...rest } = options;
  return {
    ...rest,
    onCall: (record: CallRecord) => {
      recordBudgetCall(record);
      onCall?.(record);
    },
    [STRICT_WARNINGS]: strictWarnings === true && process.env.VITEST !== undefined,
  } as Omit<O, "strictWarnings">;
}

function sizeOf(data: unknown): number {
  if (typeof data === "string") {
    return utf8ByteLength(data);
  }
  return ArrayBuffer.isView(data) || data instanceof ArrayBuffer ? data.byteLength : 0;
}

/** What `meterServer` reads its counters from. */
export interface MeteredApp {
  readonly io: QuickdrawIo;
  readonly db?: unknown;
  readonly storage?: StorageAdapter;
}

/**
 * Counts the bytes of every message `app.io` writes to a socket (events and
 * acknowledgements, once per receiving socket) and registers them, with the
 * statements of the app's tracked client, for `expectBudget`. Returns the
 * function that unregisters them, for `close()`.
 */
export function meterServer(app: MeteredApp): () => void {
  let bytes = 0;
  app.io.use((socket, next) => {
    socket.conn.on(
      "packetCreate",
      (packet: { readonly type?: unknown; readonly data?: unknown }) => {
        if (packet.type === "message") {
          bytes += sizeOf(packet.data);
        }
      },
    );
    next();
  });
  const unitOfWork = (app.storage ?? storageOf(app.db))?.unitOfWork;
  return addBudgetSource({
    counter: unitOfWork,
    statements: () => (unitOfWork === undefined ? undefined : statementsIssued(unitOfWork)),
    bytes: () => bytes,
  });
}

/** A reply's size as the HTTP transport would send it: its JSON. */
function replySize(result: DispatchResult): number | undefined {
  try {
    return utf8ByteLength(JSON.stringify(toCallReply(result)));
  } catch {
    return undefined;
  }
}

/**
 * An in-process caller acting as `principal`, through `call`, whose calls
 * report their reply's size (as JSON) in their completion records, as a
 * transport's do.
 */
export function measuredCaller(
  call: (request: DispatchRequest) => Promise<DispatchResult>,
  principal: Parameters<typeof createCaller>[1],
): object {
  return createCaller(() => (request) => call({ ...request, respond: replySize }), principal);
}
