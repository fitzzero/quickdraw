// A flush sink that keeps what it receives (RFC 0003 section 5.3), for tests
// that assert which writes a method, a `qd.run` block or a job made:
//
//   const sink = createRecordingSink();
//   const dispatcher = createDispatcher({ services, db: trackPrisma(prisma), flushSink: sink });
//   await dispatcher.caller(alice).taskService.rename({ id, title });
//   expect(sink.writes()).toEqual([expect.objectContaining({ model: "task", id, op: "update" })]);

import type { FlushInfo, FlushSink } from "../server/uow/flushSink";
import type { WriteRecord } from "../server/uow/types";

/** One flush a recording sink received. */
export interface RecordedFlush {
  readonly writes: readonly WriteRecord[];
  readonly info: FlushInfo;
}

/** A flush sink that records every flush, from {@link createRecordingSink}. */
export interface RecordingSink extends FlushSink {
  /** Every flush received so far, oldest first. */
  readonly flushes: readonly RecordedFlush[];
  /** Every write received so far, in flush order. */
  writes(): WriteRecord[];
  /** Resolves with the next flush, or with the oldest one not yet taken by `next`. */
  next(): Promise<RecordedFlush>;
  /** Forgets every flush received so far. */
  clear(): void;
}

/** Creates a {@link RecordingSink}. */
export function createRecordingSink(): RecordingSink {
  const flushes: RecordedFlush[] = [];
  const waiting: ((flush: RecordedFlush) => void)[] = [];
  let taken = 0;
  return {
    flushes,
    flush(writes: readonly WriteRecord[], info: FlushInfo): Promise<void> {
      const flush = { writes: [...writes], info };
      flushes.push(flush);
      const resolve = waiting.shift();
      if (resolve === undefined) {
        return Promise.resolve();
      }
      taken = flushes.length;
      resolve(flush);
      return Promise.resolve();
    },
    writes: () => flushes.flatMap((flush) => flush.writes),
    next(): Promise<RecordedFlush> {
      const flush = flushes[taken];
      if (flush !== undefined) {
        taken += 1;
        return Promise.resolve(flush);
      }
      return new Promise((resolve) => {
        waiting.push(resolve);
      });
    },
    clear(): void {
      flushes.length = 0;
      taken = 0;
    },
  };
}
