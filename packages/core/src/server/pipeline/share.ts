// Sharing identical reads (RFC 0003 section 9, step 6). A query that declares
// `share` runs its handler once for every identical call in flight: same
// service, method, input and, for `share: "caller"`, the same principal.
// The key is built from the parsed input, after validation and after each
// caller was authorized, so a bad payload never joins a good run and a
// joiner never skips its own access check. With `ttlMs`, a successful result
// is reused for that long after the run; an error is never kept.

import type { Principal } from "../types";

class NotShareable extends Error {}

function writePlain(value: object, seen: Set<object>): string {
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => write(item, seen, "null")).join(",")}]`;
  }
  const entries = Object.keys(value)
    .sort()
    .flatMap((key) => {
      const written = write((value as Readonly<Record<string, unknown>>)[key], seen, undefined);
      return written === undefined ? [] : [`${JSON.stringify(key)}:${written}`];
    });
  return `{${entries.join(",")}}`;
}

function writeObject(value: object, seen: Set<object>): string {
  if ("toJSON" in value && typeof value.toJSON === "function") {
    return write((value as { toJSON(): unknown }).toJSON(), seen, "null");
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new NotShareable();
  }
  if (seen.has(value)) {
    throw new NotShareable();
  }
  seen.add(value);
  const written = writePlain(value, seen);
  seen.delete(value);
  return written;
}

function write<Missing extends string | undefined>(
  value: unknown,
  seen: Set<object>,
  missing: Missing,
): string | Missing {
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : String(value);
    case "bigint":
      return `${value}n`;
    case "object":
      return value === null ? "null" : writeObject(value, seen);
    default:
      return missing;
  }
}

/**
 * Serializes a value with object keys sorted, so equal inputs give equal
 * strings whatever their key order. It follows JSON (`toJSON`, `undefined`
 * members left out) and writes a bigint as `12n`. It returns `undefined` for
 * a value it cannot key safely: a cycle, or an object other than a plain
 * object, an array or a value with `toJSON` (a `Map` would otherwise
 * serialize as `{}` and two different maps would share a result).
 */
export function stableStringify(value: unknown): string | undefined {
  try {
    return write(value, new Set(), undefined);
  } catch (error) {
    if (error instanceof NotShareable) {
      return undefined;
    }
    throw error;
  }
}

/**
 * The key one call's share run is stored under, or `undefined` when the
 * input or principal cannot be keyed (the call then runs unshared). A
 * `"caller"` key includes the whole principal, so two sessions of one user
 * with different claims or grants never share; an `"all"` key uses `*`.
 */
export function shareKey(
  service: string,
  method: string,
  principal: Principal | null | "*",
  input: unknown,
): string | undefined {
  const who = principal === "*" ? "*" : stableStringify(principal);
  const what = stableStringify(input);
  if (who === undefined || what === undefined) {
    return undefined;
  }
  return JSON.stringify([service, method, who, what]);
}

/** Recursively freezes plain objects and arrays, the way a shared result is frozen in development. */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return value;
  }
  Object.freeze(value);
  for (const member of Object.values(value)) {
    deepFreeze(member);
  }
  return value;
}

/** A run in the share table: anything with a settled-or-pending outcome. */
export interface ShareEntry<Outcome> {
  readonly outcome: Promise<Outcome>;
}

/** Runs in flight, and successful results kept for their `ttlMs`, by share key. */
export interface ShareTable<Entry extends ShareEntry<{ readonly ok: boolean }>> {
  get(key: string): Entry | undefined;
  /**
   * Stores a run under `key` until it settles. A failed run is removed at
   * once; a successful one after `ttlMs`, or at once without it.
   */
  add(key: string, entry: Entry, ttlMs: number | undefined): void;
  readonly size: number;
}

export function createShareTable<
  Entry extends ShareEntry<{ readonly ok: boolean }>,
>(): ShareTable<Entry> {
  const entries = new Map<string, Entry>();
  const remove = (key: string, entry: Entry): void => {
    if (entries.get(key) === entry) {
      entries.delete(key);
    }
  };
  return {
    get: (key) => entries.get(key),
    add(key, entry, ttlMs) {
      entries.set(key, entry);
      void entry.outcome.then((outcome) => {
        if (!outcome.ok || ttlMs === undefined) {
          remove(key, entry);
          return;
        }
        const timer = setTimeout(() => remove(key, entry), ttlMs);
        (timer as { unref?: () => void }).unref?.();
      });
    },
    get size() {
      return entries.size;
    },
  };
}
