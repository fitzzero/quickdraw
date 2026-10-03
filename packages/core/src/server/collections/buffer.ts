// The recent deltas of each collection scope (RFC 0003 section 7.3): a client
// that reconnects sends the revision it holds the scope at (`since`), and
// while this process still holds every change made since then it gets those
// deltas instead of the scope again. Bounded per scope at 500 deltas or 5
// minutes, and per process; 4.1 had no resume at all.
//
// Each scope has a floor: the oldest revision a client may hold and still be
// answered from here. Whatever this process cannot replay raises it:
//
// - a frame dropped for age or size: the floor rises to its revision;
// - a flush that changed the scope without building its deltas (nobody here
//   subscribed to it): to that revision;
// - a `reset`: past its revision, since a client must load the scope again;
// - a frame recorded after a newer one (flushes can finish out of order):
//   past the newest, since a client holding the newer revision may not have
//   received the older frame;
// - the process starting, and the state of an idle scope being forgotten,
//   which raises the floor every scope without state starts from. A scope
//   with subscribers here is pinned and never forgotten, so a client that
//   checks an unchanged scope now and then keeps resuming it;
// - a flush that changed a collection nobody here subscribes to, in scopes
//   it would have had to read to name: past every revision taken so far, for
//   every scope of that collection (`skipAll`).
//
// Deltas of one frame share its revision, and frames are kept in the order
// they went out, so a resume replays them in that order and never sorts.

import type { CollectionDelta, Revision } from "../../protocol/envelope";
import { currentRev, nextRev } from "../rev";

/** Deltas kept per scope. */
export const RESUME_MAX_DELTAS = 500;

/** How long a delta is kept, in milliseconds. */
export const RESUME_MAX_AGE_MS = 300_000;

/** Scopes without subscribers whose state is kept; past it the least recently changed is forgotten. */
export const RESUME_MAX_SCOPES = 10_000;

/** Options of {@link createDeltaBuffer}; the defaults are the RFC's bounds. */
export interface DeltaBufferOptions {
  readonly maxDeltas?: number;
  readonly maxAgeMs?: number;
  readonly maxScopes?: number;
  /** The clock, in milliseconds. Default `Date.now`. */
  readonly now?: () => number;
}

interface Frame {
  readonly rev: Revision;
  readonly at: number;
  readonly deltas: readonly CollectionDelta[];
}

interface ScopeLog {
  frames: Frame[];
  /** How many deltas `frames` hold. */
  size: number;
  /** The oldest revision a client may hold and resume from. */
  floor: Revision;
  /** The newest revision of a change to the scope this process saw. */
  newest: Revision;
  /** When the scope last changed, or lost its last subscriber. */
  at: number;
}

/** What a covered resume replays: the deltas since the client's revision, and the revision after them. */
export interface Replay {
  readonly rev: Revision;
  readonly deltas: readonly CollectionDelta[];
}

/**
 * The recent deltas of every scope, keyed by the scope's room name. A scope's
 * collection (its group, `service\0collection`) may have a floor of its own.
 */
export interface DeltaBuffer {
  /** Keeps a frame this process sent to the scope. */
  record(key: string, rev: Revision, deltas: readonly CollectionDelta[]): void;
  /** A flush at `rev` changed the scope, and its deltas were not built: no resume from before it. */
  skip(key: string, rev: Revision): void;
  /** A flush changed scopes of the group it did not name: no resume of any from before now. */
  skipAll(group: string): void;
  /** The scope was reset (or closed) at `rev`: no resume from before it. */
  reset(key: string, rev: Revision): void;
  /**
   * The deltas after `since`, in the order they went out, when every change
   * since then is still held; `undefined` when the client must load the scope.
   */
  since(key: string, since: Revision, group?: string): Replay | undefined;
  /** The oldest revision a client may hold and still resume the scope from. */
  floor(key: string, group?: string): Revision;
  /** The revision of the scope's last change this process saw, or the floor when it knows of none. */
  lastChange(key: string, group?: string): Revision;
  /** The scope has a subscriber here: keep its state. */
  pin(key: string): void;
  /** The scope's last subscriber here left: its state may be forgotten once idle. */
  unpin(key: string): void;
}

interface Logs {
  /** Scopes without subscribers here, least recently changed first. */
  readonly idle: Map<string, ScopeLog>;
  readonly pinned: Map<string, ScopeLog>;
  /** The floor of every scope of a group, past a change no scope of it named. */
  readonly groups: Map<string, Revision>;
  /** The floor of a scope without state. */
  base: Revision;
}

function logOf(logs: Logs, key: string): ScopeLog | undefined {
  return logs.pinned.get(key) ?? logs.idle.get(key);
}

/** Drops the oldest frames while the scope holds too many deltas or old ones. */
function expire(log: ScopeLog, at: number, maxDeltas: number, maxAgeMs: number): void {
  for (let first = log.frames[0]; first !== undefined; first = log.frames[0]) {
    if (log.size <= maxDeltas && first.at >= at - maxAgeMs) {
      return;
    }
    log.frames.shift();
    log.size -= first.deltas.length;
    log.floor = Math.max(log.floor, first.rev);
  }
}

/** Forgets idle scopes changed too long ago, and the least recently changed past the cap. */
function forget(logs: Logs, at: number, maxScopes: number, maxAgeMs: number): void {
  for (const [key, log] of logs.idle) {
    if (logs.idle.size <= maxScopes && log.at >= at - maxAgeMs) {
      return;
    }
    logs.idle.delete(key);
    logs.base = Math.max(logs.base, log.floor, log.newest);
  }
}

/** The scope's log, made when missing; an idle one moves to the most recently changed end. */
function changed(logs: Logs, key: string, rev: Revision, at: number): ScopeLog {
  const pinned = logs.pinned.get(key);
  const log = pinned ??
    logs.idle.get(key) ?? { frames: [], size: 0, floor: logs.base, newest: logs.base, at };
  if (pinned === undefined) {
    logs.idle.delete(key);
    logs.idle.set(key, log);
  }
  if (rev < log.newest) {
    log.floor = Math.max(log.floor, log.newest + 1);
  }
  log.newest = Math.max(log.newest, rev);
  log.at = at;
  return log;
}

/** Creates the delta buffer of one dispatcher. */
export function createDeltaBuffer(options: DeltaBufferOptions = {}): DeltaBuffer {
  const maxDeltas = options.maxDeltas ?? RESUME_MAX_DELTAS;
  const maxAgeMs = options.maxAgeMs ?? RESUME_MAX_AGE_MS;
  const maxScopes = options.maxScopes ?? RESUME_MAX_SCOPES;
  const now = options.now ?? Date.now;
  const logs: Logs = { idle: new Map(), pinned: new Map(), groups: new Map(), base: nextRev() };
  const groupFloor = (group: string | undefined): Revision =>
    group === undefined ? 0 : (logs.groups.get(group) ?? 0);
  const floor = (key: string, group?: string): Revision =>
    Math.max(logOf(logs, key)?.floor ?? logs.base, groupFloor(group));
  return Object.freeze({
    record(key: string, rev: Revision, deltas: readonly CollectionDelta[]): void {
      const at = now();
      const log = changed(logs, key, rev, at);
      log.frames.push({ rev, at, deltas: [...deltas] });
      log.size += deltas.length;
      expire(log, at, maxDeltas, maxAgeMs);
      forget(logs, at, maxScopes, maxAgeMs);
    },
    skip(key: string, rev: Revision): void {
      const at = now();
      const log = changed(logs, key, rev, at);
      log.floor = Math.max(log.floor, rev);
      forget(logs, at, maxScopes, maxAgeMs);
    },
    skipAll(group: string): void {
      // Every revision a client may hold was taken by now: none of them is covered.
      logs.groups.set(group, Math.max(groupFloor(group), currentRev() + 1));
    },
    reset(key: string, rev: Revision): void {
      const at = now();
      const log = changed(logs, key, rev, at);
      log.floor = Math.max(log.floor, rev + 1);
      log.frames = [];
      log.size = 0;
      forget(logs, at, maxScopes, maxAgeMs);
    },
    since(key: string, since: Revision, group?: string): Replay | undefined {
      const log = logOf(logs, key);
      if (log !== undefined) {
        expire(log, now(), maxDeltas, maxAgeMs);
      }
      if (since < floor(key, group)) {
        return undefined;
      }
      const frames = (log?.frames ?? []).filter((frame) => frame.rev > since);
      return {
        rev: Math.max(since, log?.newest ?? since),
        deltas: frames.flatMap((frame) => frame.deltas),
      };
    },
    floor,
    lastChange: (key: string, group?: string) =>
      Math.max(logOf(logs, key)?.newest ?? logs.base, groupFloor(group) - 1),
    pin(key: string): void {
      if (logs.pinned.has(key)) {
        return;
      }
      const log = logs.idle.get(key) ?? {
        frames: [],
        size: 0,
        floor: logs.base,
        newest: logs.base,
        at: now(),
      };
      logs.idle.delete(key);
      logs.pinned.set(key, log);
    },
    unpin(key: string): void {
      const log = logs.pinned.get(key);
      if (log === undefined) {
        return;
      }
      const at = now();
      logs.pinned.delete(key);
      log.at = at;
      logs.idle.set(key, log);
      forget(logs, at, maxScopes, maxAgeMs);
    },
  });
}
