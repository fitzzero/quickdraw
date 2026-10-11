// The access snapshot file (`accessSnapshot.ts`): `__access__/<test file>.json`
// beside the test, `{ version: 1, principals, methods, subscriptions,
// collections, excluded }` with every key sorted, so a change to who may
// call what shows in a pull request as the lines that changed. What a run
// does with it:
//
// - no file: it is written; under CI (`CI=1` or `CI=true`) that fails
//   instead, because a snapshot that writes itself pins nothing;
// - a cell whose outcome changed, or a principal whose kind did: fails,
//   naming each, until QD_UPDATE_ACCESS_SNAPSHOT=1 (or `true`) rewrites the
//   file;
// - cells added or removed only (a new method, principal or exclusion):
//   written locally, a failure under CI.
//
// QD_UPDATE_ACCESS_SNAPSHOT under CI fails: CI only compares. A budget may
// write itself under CI (`budget.ts`); an access snapshot never does.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  ACCESS_SECTIONS,
  compareAccessSnapshots,
  describeDifferences,
  describeReshape,
  hasDifferences,
  isReshaped,
  type AccessComparison,
  type AccessSnapshot,
} from "./accessSnapshotCompare";
import { runnerState, shownPath, underCi, type RunnerState } from "./budget";

/** The environment variable that rewrites access snapshots: `QD_UPDATE_ACCESS_SNAPSHOT=1` (or `true`). */
export const ACCESS_SNAPSHOT_ENV = "QD_UPDATE_ACCESS_SNAPSHOT";

/** Whether {@link ACCESS_SNAPSHOT_ENV} asks to rewrite the snapshots: `1` or `true`. */
export function updateRequested(value = process.env[ACCESS_SNAPSHOT_ENV]): boolean {
  return value === "1" || value === "true";
}

/** What a run did with the snapshot file. */
export type AccessSnapshotChange = "written" | "unchanged" | "updated";

/** The access snapshot file of `testFile`: `__access__/<its name>.json` in its directory. */
export function accessSnapshotFileOf(testFile: string): string {
  return join(dirname(testFile), "__access__", `${basename(testFile)}.json`);
}

/** Per runner, the snapshot files taken so far: path to the test that took it. */
const claimed = new WeakMap<object, Map<string, string>>();
const NO_RUNNER = {};

/** Refuses a second test of one file taking a snapshot: they would rewrite each other's. A retry is allowed. */
function claimFile(path: string, state: RunnerState): void {
  const runner = state.runner ?? NO_RUNNER;
  const files = claimed.get(runner) ?? new Map<string, string>();
  claimed.set(runner, files);
  const test = state.testName ?? "";
  const owner = files.get(path);
  if (owner !== undefined && owner !== test) {
    throw new TypeError(
      `snapshotAccessMatrix: two tests take an access snapshot into ${shownPath(path)} ("${owner}" and "${test}"); take one snapshot per test file (one test file per service, or pass { file })`,
    );
  }
  files.set(path, test);
}

/**
 * The snapshot file of a run: beside `file`, or beside the running test's
 * file (from the test runner). Throws a `TypeError` when there is neither,
 * and when another test of the file took a snapshot into it already.
 */
export function snapshotPathOf(file: string | undefined): string {
  const state = runnerState();
  const testFile = file ?? state.testPath;
  if (testFile === undefined) {
    throw new TypeError(
      "snapshotAccessMatrix: no test file is running to put the snapshot beside; pass { file }",
    );
  }
  const path = accessSnapshotFileOf(testFile);
  claimFile(path, state);
  return path;
}

type Json = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRow(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((cell) => typeof cell === "string");
}

function isPrincipal(value: unknown): boolean {
  return (
    value === null || (isRecord(value) && (value.kind === null || typeof value.kind === "string"))
  );
}

function isSnapshot(value: unknown): value is AccessSnapshot {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.principals)) {
    return false;
  }
  const { principals, excluded } = value;
  return (
    ACCESS_SECTIONS.every((section) => {
      const rows = value[section];
      return isRecord(rows) && Object.values(rows).every(isRow);
    }) &&
    Object.values(principals).every(isPrincipal) &&
    Array.isArray(excluded) &&
    excluded.every((name) => typeof name === "string")
  );
}

/** The snapshot stored at `path`, or `undefined` when there is no file; throws for a file that is not one. */
export function readAccessSnapshot(path: string): AccessSnapshot | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    parsed = undefined;
  }
  if (!isSnapshot(parsed)) {
    throw new Error(
      `snapshotAccessMatrix: ${shownPath(path)} is not an access snapshot ({ "version": 1, "principals", "methods", "subscriptions", "collections", "excluded" }); delete it to record the matrix again`,
    );
  }
  return parsed;
}

/** `value` with the keys of every object in it sorted: the same file on every machine. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  );
}

/** Writes `snapshot` to `path`, every key and the exclusions sorted, making its directory. */
export function writeAccessSnapshot(path: string, snapshot: AccessSnapshot): void {
  const sorted = { ...snapshot, excluded: [...snapshot.excluded].sort() };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sortKeys(sorted), null, 2)}\n`);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The line saying how many cells were never called, for the end of a message; none when all were. */
function inconclusiveNote(inconclusive: readonly string[]): string[] {
  if (inconclusive.length === 0) {
    return [];
  }
  return [
    `${plural(inconclusive.length, "cell was", "cells were")} never called (VALIDATION): no input passed the method's input schema; give their inputs with inputs.`,
  ];
}

/** The error of a run whose cells or principals differ from the snapshot. */
function differencesError(
  shown: string,
  comparison: AccessComparison,
  inconclusive: readonly string[],
): Error {
  const counts = [
    ...(comparison.changed.length > 0
      ? [plural(comparison.changed.length, "cell differs", "cells differ")]
      : []),
    ...(comparison.principals.length > 0
      ? [plural(comparison.principals.length, "principal differs", "principals differ")]
      : []),
  ];
  return new Error(
    [
      `snapshotAccessMatrix: ${counts.join(" and ")} from the access snapshot (${shown}):`,
      ...describeDifferences(comparison),
      ...(isReshaped(comparison) ? describeReshape(comparison) : []),
      `If every change is meant, run the tests again with ${ACCESS_SNAPSHOT_ENV}=1, review the file and commit it.`,
      ...inconclusiveNote(inconclusive),
    ].join("\n"),
  );
}

/**
 * Compares a run's `snapshot` with the file at `path` and writes the file
 * when the rules allow (see the module comment); throws when they do not.
 * `inconclusive` lists the cells never called, for the messages.
 */
export function settleSnapshot(
  path: string,
  snapshot: AccessSnapshot,
  inconclusive: readonly string[],
): AccessSnapshotChange {
  const shown = shownPath(path);
  const ci = underCi();
  const update = updateRequested();
  if (update && ci) {
    throw new Error(
      `snapshotAccessMatrix: ${ACCESS_SNAPSHOT_ENV} is set under CI, where an access snapshot is only compared: rewrite ${shown} locally, review it and commit it`,
    );
  }
  const stored = readAccessSnapshot(path);
  if (stored === undefined) {
    if (ci) {
      throw new Error(
        [
          `snapshotAccessMatrix: there is no access snapshot at ${shown}, and under CI none is written: a snapshot that writes itself pins nothing.`,
          "Run the tests locally to record it, review it and commit it.",
          ...inconclusiveNote(inconclusive),
        ].join("\n"),
      );
    }
    writeAccessSnapshot(path, snapshot);
    return "written";
  }
  const comparison = compareAccessSnapshots(stored, snapshot);
  const differs = hasDifferences(comparison);
  if (!differs && !isReshaped(comparison)) {
    return "unchanged";
  }
  if (differs && !update) {
    throw differencesError(shown, comparison, inconclusive);
  }
  if (ci) {
    throw new Error(
      [
        `snapshotAccessMatrix: the access matrix has other cells than its snapshot (${shown}); rerun locally to accept:`,
        ...describeReshape(comparison),
        "Run the tests without CI to write the snapshot, review it and commit it.",
        ...inconclusiveNote(inconclusive),
      ].join("\n"),
    );
  }
  writeAccessSnapshot(path, snapshot);
  return "updated";
}
