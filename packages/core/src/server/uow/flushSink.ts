// The flush sink seam (RFC 0003 section 5.3): where a unit of work's writes
// go once the response is sent. The tracked-writes card implements the flush
// (merge per row, take a revision, expand `affects`, read the touched rows,
// emit frames and deltas); the transport supplies the rooms it emits to.

import type { UnitOfWorkScope, WriteRecord } from "./types";

/**
 * Receives the writes of one handler run after the response has been sent.
 * A failure is logged with the affected rows and never fails the response.
 */
export interface FlushSink {
  flush(writes: readonly WriteRecord[], scope: Omit<UnitOfWorkScope, "sink">): Promise<void>;
}

/** The default sink: there is nothing to emit until writes are tracked. */
export const noFlushSink: FlushSink = Object.freeze({
  flush: (): Promise<void> => Promise.resolve(),
});
