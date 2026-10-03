// The flush sink seam (RFC 0003 section 5.3): where a unit of work's writes
// go once the response is sent. The unit merges its writes per row and takes
// one revision (`flush.ts`); each sink then turns the batch into what it
// emits: entity frames, collection deltas, change signals, cache evictions.

import type { Revision } from "../../protocol/envelope";
import type { UnitOfWorkScope, WriteRecord } from "./types";

/** What a sink learns about a flush besides its writes: where they came from, and the flush's revision. */
export interface FlushInfo extends Omit<UnitOfWorkScope, "sink"> {
  /**
   * The flush's revision (RFC 0003 section 5.3, step 2), taken once for the
   * whole batch before any sink runs, so before any row is read.
   */
  readonly rev: Revision;
}

/**
 * Receives the writes of one unit of work after the response has been sent:
 * one record per row, merged. A failure is logged with the affected rows and
 * never fails the response.
 */
export interface FlushSink {
  flush(writes: readonly WriteRecord[], info: FlushInfo): Promise<void>;
  /**
   * Called when another sink failed to flush this batch, after every sink
   * ran, so this one can make up for what that one did not send (the
   * collections sink sends a `reset`). Its own failure is logged.
   */
  onFlushError?(
    writes: readonly WriteRecord[],
    info: FlushInfo,
    error: unknown,
  ): void | Promise<void>;
}

/** The default sink: there is nothing to emit until writes are tracked. */
export const noFlushSink: FlushSink = Object.freeze({
  flush: (): Promise<void> => Promise.resolve(),
});
