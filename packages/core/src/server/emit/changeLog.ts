// The in-process change log (RFC 0003 section 6): the revision of the last
// flush that touched each row, since the process started. It answers "not
// modified" for services without a `versionColumn`: a caller holding a row
// at revision `v` gets "not modified" when no flush since `v` touched it.
//
// It is bounded: past `maxEntries` rows the least recently changed one is
// dropped, and the log then knows only that the dropped row did not change
// after the newest revision it has dropped (its floor). It starts with a
// floor of the revision current when it was made, so a revision from before
// the process started is never answered "not modified".
//
// It sees the writes this process flushes and nothing else: not raw SQL
// without `ctx.touch`, not database cascades, not other processes. A
// deployment of several processes behind a load balancer stops it answering
// (`changeLog: false`) or gives its services a `versionColumn`; behind a
// Socket.IO cluster adapter it never answers. It is kept either way:
// subscriptions also use it to tell a deleted row from a forbidden one, and
// to catch a flush that raced a subscribe.

import type { Revision } from "../../protocol/envelope";
import { nextRev } from "../rev";

/** The change log's options: `false` turns it off. */
export interface ChangeLogOptions {
  /** How many rows it keeps. Default 100,000. */
  readonly maxEntries?: number;
}

interface Entry {
  readonly rev: Revision;
  /** The row's last recorded write deleted it. */
  readonly removed: boolean;
}

/** The last flush revision per row. */
export interface ChangeLog {
  /** Records that the flush at `rev` wrote the row; `removed` when that write deleted it. */
  record(service: string, id: string, rev: Revision, removed: boolean): void;
  /** The revision of the row's last recorded change, or the floor when none is kept. */
  lastChange(service: string, id: string): Revision;
  /** True when the row's last recorded change deleted it. */
  removed(service: string, id: string): boolean;
  /** True when no flush this process saw since `rev` touched the row. */
  unchangedSince(service: string, id: string, rev: Revision): boolean;
}

const DEFAULT_MAX_ENTRIES = 100_000;

function keyOf(service: string, id: string): string {
  return `${service}\u0000${id}`;
}

/** Creates a change log, starting at the revision current now. */
export function createChangeLog(options: ChangeLogOptions = {}): ChangeLog {
  const max = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new TypeError("createDispatcher: changeLog.maxEntries must be a positive whole number");
  }
  const entries = new Map<string, Entry>();
  let floor = nextRev();
  const lastChange = (service: string, id: string): Revision =>
    entries.get(keyOf(service, id))?.rev ?? floor;
  return Object.freeze({
    record(service: string, id: string, rev: Revision, removed: boolean): void {
      const key = keyOf(service, id);
      const kept = entries.get(key);
      // Flushes can finish out of order; the newest revision wins.
      const entry = kept !== undefined && kept.rev > rev ? kept : { rev, removed };
      entries.delete(key);
      entries.set(key, entry);
      const first = entries.size > max ? entries.entries().next() : undefined;
      if (first !== undefined && first.done !== true) {
        const [oldest, dropped] = first.value;
        entries.delete(oldest);
        floor = Math.max(floor, dropped.rev);
      }
    },
    lastChange,
    removed: (service: string, id: string) => entries.get(keyOf(service, id))?.removed === true,
    unchangedSince: (service: string, id: string, rev: Revision) => lastChange(service, id) <= rev,
  });
}
