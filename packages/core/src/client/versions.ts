// What the client knows about each cached query result: the version it was
// answered with (RFC 0003 section 9, step 5), so the next fetch of that query
// can send it back as `v` and be answered "not modified"; and when its read
// was sent, on the overlay store's clock (`optimistic.ts`), so the overlays
// of mutations that had finished by then are not shown over it again. Both
// belong to the data object they came with, not to the query key: data
// written into the cache some other way (`setQueryData`, a live frame) is a
// new object with neither, so the client never claims to hold a version of
// data it does not hold. Weak maps forget them with the data.
//
// Results that are not objects (a count, a string) carry neither; their
// queries simply always run.
//
// React-free.

import type { Version } from "../protocol/envelope";

const versions = new WeakMap<object, Version>();
const reads = new WeakMap<object, number>();

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/** The version `data` was answered with, if it was answered with one. */
export function versionOf(data: unknown): Version | undefined {
  return isObject(data) ? versions.get(data) : undefined;
}

/** Records that `data` was answered with `version`. */
export function rememberVersion(data: unknown, version: Version | undefined): void {
  if (isObject(data) && version !== undefined) {
    versions.set(data, version);
  }
}

/** When the newest read that returned `data` was sent, on the overlay store's clock. */
export function readAtOf(data: unknown): number | undefined {
  return isObject(data) ? reads.get(data) : undefined;
}

/** Records that a read sent at `readAt` returned `data`; a later read of the same object wins. */
export function rememberReadAt(data: unknown, readAt: number | undefined): void {
  if (isObject(data) && readAt !== undefined) {
    reads.set(data, Math.max(readAt, reads.get(data) ?? readAt));
  }
}

/**
 * Gives `kept` the version and read time of `received` when the cache keeps
 * another object for it: TanStack's structural sharing keeps the old object
 * when the new data is deeply equal to it, or a copy that reuses its
 * unchanged parts.
 */
export function carryVersion(received: unknown, kept: unknown): void {
  if (kept !== received) {
    rememberVersion(kept, versionOf(received));
    rememberReadAt(kept, readAtOf(received));
  }
}
