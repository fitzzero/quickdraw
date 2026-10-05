// How a live entity's cached entry changes (RFC 0003 section 6): by revision
// per row, never by arrival order. 4.1 merged every update into the cached
// row as it arrived and carried no revision at all
// (4.1 `src/client/useSubscription.ts:106-126`).
//
// - `u` (the whole row) replaces the entry unless the entry is newer.
// - `p` (changed fields) merges into the row unless the entry is newer;
//   with no row cached there is nothing to merge into, so the row is
//   requested instead of making a partial one.
// - `r` removes the row and leaves a tombstone at its revision, which only a
//   `u` or a subscribe reply that is not older clears.
// - A `qd:sub` reply may carry a revision older than a frame that arrived
//   right after the join, so an entry newer than the reply keeps its row.
//   "Not modified" keeps the row; with none cached any more, it is requested
//   again. A row the server does not have (`NOT_FOUND`) is removed;
//   `FORBIDDEN` drops the row and keeps the error.
//
// "Newer" compares revisions; two frames with the same revision apply in the
// order they arrive. Pure functions, React-free.

import type { EntityFrame, EntityResult, Revision } from "../../protocol/envelope";
import { QuickdrawError, fromWire } from "../../protocol/errors";
import { isName, isRecord } from "../../protocol/guards";
import { isRevision } from "./host";

/** What the cache holds for one live row, under `["qd", service, "e", id]`. */
export interface EntityEntry<Row = unknown> {
  /** The row, as the subscriber's access tier sees it; `undefined` until loaded, once removed, or after an error. */
  readonly data: Row | undefined;
  /** The revision of `data`, or of the removal; `undefined` before anything arrived. */
  readonly rev: Revision | undefined;
  /** The server removed the row (or never had it): a tombstone at `rev`. */
  readonly removed: boolean;
  /** Why the subscription failed or ended: `FORBIDDEN` when access was refused or revoked. */
  readonly error: QuickdrawError | null;
  /**
   * When the request that read `data` was sent, on the overlay store's clock
   * (`optimistic.ts`); `undefined` for a row a frame brought.
   */
  readonly readAt: number | undefined;
}

/** The entry of a row nothing arrived for yet. */
export const EMPTY_ENTITY: EntityEntry<never> = Object.freeze({
  data: undefined,
  rev: undefined,
  removed: false,
  error: null,
  readAt: undefined,
});

/** What applying a frame or a reply did. */
export interface EntityChange<Row> {
  /** The new entry: the same object when nothing changed. */
  readonly entry: EntityEntry<Row>;
  /** True when the row must be requested: a patch or "not modified" found no row to apply to. */
  readonly request: boolean;
}

function unchanged<Row>(entry: EntityEntry<Row>): EntityChange<Row> {
  return { entry, request: false };
}

function changed<Row>(entry: EntityEntry<Row>): EntityChange<Row> {
  return { entry: Object.freeze(entry), request: false };
}

/** True when the entry holds something newer than revision `rev`. */
function isNewer(entry: EntityEntry<unknown>, rev: Revision): boolean {
  return entry.rev !== undefined && entry.rev > rev;
}

/** The row with `fields` merged in, when both are objects. */
function merged<Row>(row: Row, fields: unknown): Row {
  return isRecord(row) && isRecord(fields) ? ({ ...row, ...fields } as Row) : row;
}

/** Applies one `qd:e` frame to the entry of its row (`undefined` when none is cached). */
export function applyEntityFrame<Row>(
  held: EntityEntry<Row> | undefined,
  frame: EntityFrame<Row>,
): EntityChange<Row> {
  const entry = held ?? (EMPTY_ENTITY as EntityEntry<Row>);
  if (isNewer(entry, frame.rev)) {
    return unchanged(entry);
  }
  if (frame.t === "r") {
    return changed<Row>({ ...EMPTY_ENTITY, rev: frame.rev, removed: true });
  }
  if (frame.t === "u") {
    return changed({ ...EMPTY_ENTITY, data: frame.d, rev: frame.rev });
  }
  if (entry.data === undefined) {
    return { entry, request: true };
  }
  return changed({ ...entry, data: merged(entry.data, frame.d), rev: frame.rev });
}

/**
 * Applies one id's answer to `qd:sub`, read by a request sent at `readAt`
 * on the overlay store's clock.
 */
export function applyEntityResult<Row>(
  held: EntityEntry<Row> | undefined,
  result: EntityResult<Row>,
  readAt: number | undefined,
): EntityChange<Row> {
  const entry = held ?? (EMPTY_ENTITY as EntityEntry<Row>);
  if (result.ok === false) {
    const error = fromWire(result.e);
    if (error.code === "NOT_FOUND") {
      return changed<Row>({ ...EMPTY_ENTITY, rev: entry.rev, removed: true });
    }
    return changed<Row>({ ...EMPTY_ENTITY, rev: entry.rev, error });
  }
  if (result.nm === true) {
    if (entry.data === undefined) {
      return { entry, request: true };
    }
    return entry.error === null ? unchanged(entry) : changed({ ...entry, error: null });
  }
  // Only a row or a tombstone the entry holds can be newer than the reply.
  const holds = entry.data !== undefined || entry.removed;
  if (holds && isNewer(entry, result.rev)) {
    return entry.error === null ? unchanged(entry) : changed({ ...entry, error: null });
  }
  return changed({ ...EMPTY_ENTITY, data: result.d, rev: result.rev, readAt });
}

/** The entry after the server revoked the subscription (`qd:revoked`): no row, and `FORBIDDEN`. */
export function revokedEntity<Row>(held: EntityEntry<Row> | undefined): EntityEntry<Row> {
  return Object.freeze({
    ...EMPTY_ENTITY,
    rev: held?.rev,
    error: new QuickdrawError("FORBIDDEN", "Access to the row was revoked"),
  });
}

/** The entry after a whole `qd:sub` batch failed: the row stays, and the error is shown. */
export function failedEntity<Row>(
  held: EntityEntry<Row> | undefined,
  error: QuickdrawError,
): EntityEntry<Row> {
  return Object.freeze({ ...(held ?? (EMPTY_ENTITY as EntityEntry<Row>)), error });
}

/** The revision to send in `qd:sub` for the entry: the row's, or `null` when no row is held. */
export function heldRevision(entry: EntityEntry<unknown> | undefined): Revision | null {
  return entry?.data !== undefined && entry.rev !== undefined ? entry.rev : null;
}

/** True when `value` has the shape of a `qd:e` frame. Frames come over the network: checked, not trusted. */
export function isEntityFrame(value: unknown): value is EntityFrame {
  if (!isRecord(value) || !isName(value.s) || !isName(value.id) || !isRevision(value.rev)) {
    return false;
  }
  if (value.t === "r") {
    return true;
  }
  if (value.t === "u") {
    return Object.hasOwn(value, "d");
  }
  return value.t === "p" && isRecord(value.d);
}

/** One id's answer to `qd:sub`, checked: a malformed answer stands for `INTERNAL`. */
export function entityResultOf(value: unknown): EntityResult {
  if (isRecord(value) && value.ok === false) {
    return value as unknown as EntityResult;
  }
  const answered =
    isRecord(value) &&
    value.ok === true &&
    isRevision(value.rev) &&
    (value.nm === true || Object.hasOwn(value, "d"));
  return answered
    ? (value as unknown as EntityResult)
    : { ok: false, e: { code: "INTERNAL", message: "The server's qd:sub reply is malformed" } };
}
