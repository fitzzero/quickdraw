// Sharing identical reads (RFC 0003 section 9, step 6). A query that declares
// `share` runs its handler once for every identical call in flight: same
// service, method, input and, for `share: "caller"`, the same principal over
// the same transport with the same `ctx.mcp`. The key is built from the
// parsed input, after validation and after each caller was authorized, so a
// bad payload never joins a good run and a joiner never skips its own access
// check. With `ttlMs`, a successful result is reused for that long after the
// run; an error is never kept.
//
// Two calls share only when their keys are equal, so a key must tell apart
// everything a handler can tell apart. JSON does not: it drops function
// members and symbol keys, and it writes whatever a `toJSON` returns. Two
// sessions of one user whose principals differ only in a `can()` method, or
// in claims a `toJSON` leaves out, would share a run computed with the first
// one's rights. The key writer below is strict instead: it writes plain data
// only, and a value it cannot write in full makes the call run unshared.

import type { McpContext, Principal, Transport } from "../types";

class NotShareable extends Error {}

function refuse(): never {
  throw new NotShareable();
}

/** The own members of a plain object or array, by name; anything else in it is refused. */
function ownValues(value: object): Map<string, unknown> {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    refuse();
  }
  const values = new Map<string, unknown>();
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    // A getter could answer differently for each caller; only data is keyed.
    if (!("value" in descriptor)) {
      refuse();
    }
    values.set(key, descriptor.value);
  }
  return values;
}

function writeArray(value: readonly unknown[], seen: Set<object>): string {
  const values = ownValues(value);
  // Dense, with no members besides its items and `length`.
  if (values.size !== value.length + 1) {
    refuse();
  }
  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    if (!values.has(key)) {
      refuse();
    }
    items.push(write(values.get(key), seen));
  }
  return `[${items.join(",")}]`;
}

function writeRecord(value: object, seen: Set<object>): string {
  const values = ownValues(value);
  const entries = [...values.keys()]
    .sort()
    .map((key) => `${JSON.stringify(key)}:${write(values.get(key), seen)}`);
  return `{${entries.join(",")}}`;
}

/** A plain object, an array, or a `Date`; anything else (a class instance, a `Map`, a `toJSON`) is refused. */
function writeObject(value: object, seen: Set<object>): string {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype === Date.prototype && Reflect.ownKeys(value).length === 0) {
    return `Date(${(value as Date).getTime()})`;
  }
  const array = prototype === Array.prototype && Array.isArray(value);
  if (!array && prototype !== Object.prototype && prototype !== null) {
    refuse();
  }
  if (seen.has(value)) {
    refuse();
  }
  seen.add(value);
  const written = array ? writeArray(value as unknown[], seen) : writeRecord(value, seen);
  seen.delete(value);
  return written;
}

function write(value: unknown, seen: Set<object>): string {
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (Object.is(value, -0)) {
        return "-0";
      }
      return Number.isFinite(value) ? JSON.stringify(value) : String(value);
    case "bigint":
      return `${value}n`;
    case "undefined":
      return "undefined";
    case "object":
      return value === null ? "null" : writeObject(value, seen);
    default:
      // A function or a symbol: nothing a key could compare.
      return refuse();
  }
}

/**
 * Writes a value as a share key: object keys sorted, so equal values give
 * equal strings whatever their key order, and two values that differ in any
 * member give different strings. It writes strings, numbers (`-0`, `NaN` and
 * the infinities included), booleans, `null`, `undefined`, bigints (`12n`),
 * dates (`Date(0)`), arrays and plain objects. It returns `undefined` for
 * anything else, so the call runs unshared: a function or symbol anywhere, a
 * symbol key, a getter, a sparse array, a cycle, or an object that is not
 * plain (a class instance, with or without `toJSON`, a `Map`, a `Buffer`).
 */
export function stableStringify(value: unknown): string | undefined {
  try {
    return write(value, new Set());
  } catch (error) {
    if (error instanceof NotShareable) {
      return undefined;
    }
    throw error;
  }
}

/** Who a `share: "caller"` run belongs to. */
export interface ShareCaller {
  readonly principal: Principal | null;
  readonly transport: Transport;
  /** The call's `ctx.mcp`, when the MCP bridge set one. */
  readonly mcp: McpContext | undefined;
}

/**
 * The key one call's share run is stored under, or `undefined` when the
 * input or the caller cannot be keyed (the call then runs unshared). A
 * `"caller"` key includes the whole principal, the transport and the call's
 * `ctx.mcp`, so two sessions of one user with different claims, grants or
 * MCP token scopes never share, and neither do one principal's calls over two
 * transports; an `"all"` key uses `*`.
 */
export function shareKey(
  service: string,
  method: string,
  caller: ShareCaller | "*",
  input: unknown,
): string | undefined {
  const who =
    caller === "*" ? "*" : stableStringify([caller.principal, caller.transport, caller.mcp]);
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
