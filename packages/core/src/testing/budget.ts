// `expectBudget` (RFC 0003 section 13): performance as something a test can
// fail on. It runs one step of a test against the apps `createTestApp`
// started and records what the step cost, then compares that with the
// budget file next to the test, `__budgets__/<test file>.json`:
//
// - per call (a method call through `app.as(...)`, a socket or HTTP), its
//   service and method, the database statements its handler ran and the
//   bytes of its reply, from the call's completion record;
// - for the whole step, every statement the apps' tracked database clients
//   ran (access checks, flushes and subscriptions included) and every byte
//   their servers wrote to sockets, plus the in-process replies.
//
// Counts and bytes, never time, so a budget is the same on every machine. A
// missing entry is written. A rise fails with the old and new numbers, unless
// QD_ALLOW_BUDGET_GROWTH allows it (`1` for every budget, or a comma-separated
// list of budget names), which writes the new budget instead. A fall is
// written locally, so the budget tightens as the code improves; under CI
// (`CI=1` or `CI=true`) it fails too, so removed work is noticed and accepted
// by running the tests locally. Bytes move by up to 5% either way without
// counting as a change (ids and timestamps vary in length); statements must
// match exactly. Two tests of one file may not name a step alike.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { CallRecord } from "../server/pipeline/metrics";
import {
  compareBudgets,
  describeChanges,
  mergeBudget,
  type Budget,
  type BudgetCall,
} from "./budgetCompare";

export type { Budget, BudgetCall };

/**
 * The environment variable that lets a budget grow: `QD_ALLOW_BUDGET_GROWTH=1`
 * for every budget, or a comma-separated list of budget names.
 */
export const BUDGET_GROWTH_ENV = "QD_ALLOW_BUDGET_GROWTH";

/** Whether {@link BUDGET_GROWTH_ENV} lets the budget `name` grow: `1`, or a list naming it. */
export function growthAllowed(name: string, value = process.env[BUDGET_GROWTH_ENV]): boolean {
  if (value === undefined) {
    return false;
  }
  const allowed = value.split(",").map((item) => item.trim());
  return (allowed.length === 1 && allowed[0] === "1") || allowed.includes(name);
}

/** Whether the tests run under CI (`CI=1` or `CI=true`), where a budget that fell fails. */
export function underCi(value = process.env.CI): boolean {
  return value === "1" || value === "true";
}

/** Options of {@link expectBudget}. */
export interface BudgetOptions {
  /** The entry's name in the budget file: unique within the test file. */
  readonly name: string;
  /**
   * The test file the budget file sits next to. Default: the running test's
   * file, from the test runner (vitest, or jest's `expect.getState()`).
   */
  readonly file?: string;
}

/** What {@link expectBudget} measured, and what it did with the budget file. */
export interface BudgetResult {
  readonly name: string;
  /** The budget file. */
  readonly path: string;
  /** What the step cost. */
  readonly measured: Budget;
  /**
   * `"written"`: there was no entry; `"unchanged"`: within the budget;
   * `"lowered"`: below it, and the entry now says so; `"grown"`: above it,
   * accepted with QD_ALLOW_BUDGET_GROWTH=1.
   */
  readonly change: "written" | "unchanged" | "lowered" | "grown";
}

/** A test app's counters, which `createTestApp` registers while the app runs. */
export interface BudgetSource {
  /** Identifies the tracked client the statements are counted on: apps sharing one count once. */
  readonly counter: object | undefined;
  /** Statements the app's tracked client has run so far; `undefined` without one. */
  statements(): number | undefined;
  /** Bytes the app's server has written to its sockets so far. */
  bytes(): number;
}

const sources = new Set<BudgetSource>();

let recording: CallRecord[] | undefined;

/** Registers a test app's counters; returns the function that removes them. */
export function addBudgetSource(source: BudgetSource): () => void {
  sources.add(source);
  return () => {
    sources.delete(source);
  };
}

/** Hands a completion record to the step being measured, if any: a test app's `onCall`. */
export function recordBudgetCall(record: CallRecord): void {
  recording?.push(record);
}

interface Totals {
  readonly statements: number;
  readonly bytes: number;
}

function totalsOf(live: readonly BudgetSource[]): Totals {
  const counted = new Set<object>();
  let statements = 0;
  let bytes = 0;
  for (const source of live) {
    bytes += source.bytes();
    if (source.counter === undefined || counted.has(source.counter)) {
      continue;
    }
    counted.add(source.counter);
    statements += source.statements() ?? 0;
  }
  return { statements, bytes };
}

/** Socket replies are among the bytes the servers wrote; every other reply is added on its own. */
function viaSocket(record: CallRecord): boolean {
  return record.transport === "socket" || record.transport === "legacy";
}

function callOf(record: CallRecord): BudgetCall {
  return {
    call: `${record.service}.${record.method}`,
    statements: record.sqlStatements ?? 0,
    bytes: record.bytes,
    ...(record.outcome === "ok" ? {} : { outcome: record.outcome }),
  };
}

/** Strings by UTF-16 code unit: the same order on every machine, whatever its locale. */
function byCodeUnit(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** Calls in a stable order, so concurrent calls compare the same on every run. */
export function byCall(a: BudgetCall, b: BudgetCall): number {
  return (
    byCodeUnit(a.call, b.call) ||
    byCodeUnit(a.outcome ?? "", b.outcome ?? "") ||
    a.statements - b.statements ||
    a.bytes - b.bytes
  );
}

function budgetOf(before: Totals, after: Totals, records: readonly CallRecord[]): Budget {
  const replies = records
    .filter((record) => !viaSocket(record))
    .reduce((sum, record) => sum + record.bytes, 0);
  return {
    statements: after.statements - before.statements,
    bytes: after.bytes - before.bytes + replies,
    calls: records.map(callOf).sort(byCall),
  };
}

/** Waits for work the step's last reply left behind, such as an ambient flush. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Runs `run` and measures it. */
async function measure(run: () => unknown): Promise<Budget> {
  if (recording !== undefined) {
    throw new Error("expectBudget: another budget is being measured; measure one step at a time");
  }
  const live = [...sources];
  if (live.length === 0) {
    throw new Error("expectBudget: no test app is running; start one with createTestApp first");
  }
  const before = totalsOf(live);
  const records: CallRecord[] = [];
  recording = records;
  try {
    await run();
    await settle();
  } finally {
    recording = undefined;
  }
  return budgetOf(before, totalsOf(live), records);
}

const EXPECT_GLOBAL = Symbol.for("expect-global");

/** The test runner's global `expect` (vitest's, or jest's), and the running test's file and name. */
interface RunnerState {
  readonly runner: object | undefined;
  readonly testPath: string | undefined;
  readonly testName: string | undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** What the test runner's global `expect` says about the running test. */
function runnerState(): RunnerState {
  const holder = globalThis as Record<PropertyKey, unknown>;
  for (const candidate of [holder[EXPECT_GLOBAL], holder.expect]) {
    const getState = (candidate as { readonly getState?: unknown } | undefined)?.getState;
    if (typeof getState === "function") {
      const state = (getState as () => unknown).call(candidate) as {
        readonly testPath?: unknown;
        readonly currentTestName?: unknown;
      };
      return {
        runner: candidate as object,
        testPath: nonEmpty(state.testPath),
        testName: nonEmpty(state.currentTestName),
      };
    }
  }
  return { runner: undefined, testPath: undefined, testName: undefined };
}

/** Per test runner, the steps measured so far: `budget file\0name` to the test that measured it. */
const claimed = new WeakMap<object, Map<string, string>>();
const NO_RUNNER = {};

/**
 * Refuses a step name another test of the same file used: two tests sharing
 * an entry would rewrite each other's budget. The same test measuring it
 * again (a retry) is allowed.
 */
function claimName(path: string, name: string, state: RunnerState): void {
  const runner = state.runner ?? NO_RUNNER;
  const names = claimed.get(runner) ?? new Map<string, string>();
  claimed.set(runner, names);
  const key = `${path}\u0000${name}`;
  const test = state.testName ?? "";
  const owner = names.get(key);
  if (owner !== undefined && owner !== test) {
    throw new TypeError(
      `expectBudget: two tests of ${shownPath(path)} name a step "${name}" ("${owner}" and "${test}"); give each step its own name`,
    );
  }
  names.set(key, test);
}

/** `path` relative to the working directory when it is inside it. */
function shownPath(path: string): string {
  const near = relative(process.cwd(), path);
  return near.startsWith("..") ? path : near;
}

/** The budget file of `testFile`: `__budgets__/<its name>.json` in its directory. */
export function budgetFileOf(testFile: string): string {
  return join(dirname(testFile), "__budgets__", `${basename(testFile)}.json`);
}

/** A budget file: `{ "version": 1, "budgets": { [name]: Budget } }`, names sorted. */
interface BudgetFile {
  readonly version: 1;
  readonly budgets: Readonly<Record<string, unknown>>;
}

function readBudgets(path: string): Readonly<Record<string, unknown>> {
  if (!existsSync(path)) {
    return {};
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BudgetFile> | null;
  if (parsed?.version !== 1 || typeof parsed.budgets !== "object" || parsed.budgets === null) {
    throw new Error(
      `expectBudget: ${path} is not a budget file ({ "version": 1, "budgets": {...} })`,
    );
  }
  return parsed.budgets;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCall(value: unknown): value is BudgetCall {
  const call = value as Partial<Record<keyof BudgetCall, unknown>> | null;
  return (
    typeof value === "object" &&
    call !== null &&
    typeof call.call === "string" &&
    isCount(call.statements) &&
    isCount(call.bytes)
  );
}

function isBudget(value: unknown): value is Budget {
  const budget = value as Partial<Record<keyof Budget, unknown>> | null;
  return (
    typeof value === "object" &&
    budget !== null &&
    isCount(budget.statements) &&
    isCount(budget.bytes) &&
    Array.isArray(budget.calls) &&
    (budget.calls as readonly unknown[]).every(isCall)
  );
}

/** The entry `name` of the budget file at `path`, or `undefined` when it has none. */
function storedBudget(path: string, name: string): Budget | undefined {
  const budgets = readBudgets(path);
  if (!Object.hasOwn(budgets, name)) {
    return undefined;
  }
  const stored: unknown = budgets[name];
  if (!isBudget(stored)) {
    throw new Error(
      `expectBudget("${name}"): its entry in ${path} is not a budget; delete it to measure it again`,
    );
  }
  return stored;
}

function writeBudget(path: string, name: string, budget: Budget): void {
  const budgets: Record<string, unknown> = { ...readBudgets(path), [name]: budget };
  const sorted = Object.fromEntries(
    Object.keys(budgets)
      .sort()
      .map((key) => [key, budgets[key]]),
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 1, budgets: sorted }, null, 2)}\n`);
}

function checkOptions(options: BudgetOptions): { readonly name: string; readonly path: string } {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("expectBudget(run, { name }): pass the budget's name");
  }
  const { name } = options;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new TypeError("expectBudget: name must be a non-empty string");
  }
  const state = runnerState();
  const file = options.file ?? state.testPath;
  if (file === undefined) {
    throw new TypeError(
      "expectBudget: no test file is running to put the budget beside; pass { file }",
    );
  }
  const path = budgetFileOf(file);
  claimName(path, name, state);
  return { name, path };
}

/**
 * Runs `run`, one step of a test, and compares what it cost with its entry in
 * the budget file next to the test (`__budgets__/<test file>.json`): the
 * database statements and reply bytes of each call it made, and every
 * statement and socket byte of the step. Rejects when the step costs more
 * than its budget, naming each number that grew with its old and new values,
 * unless `QD_ALLOW_BUDGET_GROWTH` allows it (`1`, or a comma-separated list
 * of names); writes the entry when it is new, lower, or allowed to grow.
 * Under CI (`CI=1` or `CI=true`) a lower step fails as well ("budget
 * changed; rerun locally to accept"). Two tests of one file may not name a
 * step alike (`TypeError`). Measure one step at a time.
 *
 * A call's statements are its handler's, as its completion record counts
 * them: the access check before the handler is not among them, a kit's reads
 * to filter by access are, and a call that joined another's shared run
 * counts none. The step's statements count everything the apps' tracked
 * clients ran while `run` did, access checks and flushes included. Await,
 * in `run`, everything the step should cost: the replies and the frames it
 * is about.
 *
 * @example
 * await expectBudget(() => app.as(ada).taskService.list({ limit: 20 }), { name: "list as owner" });
 */
export async function expectBudget(
  run: () => unknown,
  options: BudgetOptions,
): Promise<BudgetResult> {
  if (typeof run !== "function") {
    throw new TypeError("expectBudget: run must be a function that makes the step's calls");
  }
  const { name, path } = checkOptions(options);
  const measured = await measure(run);
  const stored = storedBudget(path, name);
  if (stored === undefined) {
    writeBudget(path, name, measured);
    return { name, path, measured, change: "written" };
  }
  const comparison = compareBudgets(stored, measured);
  if (comparison.grew && !growthAllowed(name)) {
    throw new Error(
      `expectBudget("${name}"): the step costs more than its budget (${shownPath(path)}):\n` +
        `${describeChanges(comparison)}\n` +
        `Make it cheaper, or set ${BUDGET_GROWTH_ENV}=1 (or ${BUDGET_GROWTH_ENV}="${name}") to accept the new budget.`,
    );
  }
  if (!comparison.grew && !comparison.fell) {
    return { name, path, measured, change: "unchanged" };
  }
  if (!comparison.grew && underCi()) {
    throw new Error(
      `expectBudget("${name}"): budget changed; rerun locally to accept (${shownPath(path)}):\n` +
        `${describeChanges(comparison, "fell")}\n` +
        "The step costs less than its budget: run the tests without CI to write the lower budget, and commit it.",
    );
  }
  writeBudget(path, name, mergeBudget(stored, measured, comparison));
  return { name, path, measured, change: comparison.grew ? "grown" : "lowered" };
}
