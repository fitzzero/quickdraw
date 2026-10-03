// The version each cached query result was answered with (RFC 0003 section 9,
// step 5), so the next fetch of that query can send it back as `v` and be
// answered "not modified". A version belongs to the data object it came
// with, not to the query key: data written into the cache some other way
// (`setQueryData`, an optimistic overlay, a live frame) is a new object with
// no version, so the client never claims to hold a version of data it does
// not hold. A weak map forgets a version with its data.
//
// Results that are not objects (a count, a string) carry no version; their
// queries simply always run.
//
// React-free.

import type { Version } from "../protocol/envelope";

const versions = new WeakMap<object, Version>();

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

/**
 * Gives `kept` the version of `received` when the cache keeps another object
 * for it: TanStack's structural sharing keeps the old object when the new
 * data is deeply equal to it, or a copy that reuses its unchanged parts.
 */
export function carryVersion(received: unknown, kept: unknown): void {
  if (kept !== received) {
    rememberVersion(kept, versionOf(received));
  }
}
