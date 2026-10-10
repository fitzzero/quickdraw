// `snapshotAccessMatrix` (RFC 0003 section 13): who may call what, for every
// method, entity subscribe and collection scope of an app's services and
// every principal, recorded once in a file beside the test and compared on
// every later run, so a changed cell fails until someone accepts it.
// `describeAccessMatrix` pins hand-written cases of one service; a
// migration, a policy refactor or a new principal kind wants the whole
// table, diffed.
//
//   await snapshotAccessMatrix(app, {
//     principals: (board) => ({ owner: { userId: board.ada }, member: { userId: board.bo } }),
//     reset: async () => {
//       await resetDatabase(prisma);
//       return await seed(prisma);
//     },
//     rows: (board) => ({ projectService: board.p1, taskService: { own: board.t1, other: board.t2 } }),
//   });
//
// Each principal, and an anonymous caller, runs in turn: every entity
// subscribe and collection scope over a socket of its own, then every query,
// then every mutation, in process, each with a real input: the app's
// (`inputs`), or one made from the input's JSON Schema with the cell's row
// where the method's access form reads it (`accessInputs.ts`). A mutation
// the pipeline did not refuse may have written, so `reset` runs again after
// it, and every cell sees the rows `reset` makes. What runs is planned
// before any cell (`accessSnapshotPlan.ts`); the file is
// `__access__/<test file>.json` (`accessSnapshotFile.ts`).

import { QuickdrawError } from "../protocol/errors";
import type { PrincipalOfServices } from "../server/dispatcher";
import type { AnyService, ServiceMethod } from "../server/service";
import type { Principal } from "../server/types";
import { generatedInput, isValidInput } from "./accessInputs";
import type {
  AccessOutcome,
  AccessSnapshot,
  AccessSnapshotPrincipal,
  AccessSnapshotRow,
} from "./accessSnapshotCompare";
import { settleSnapshot, snapshotPathOf, type AccessSnapshotChange } from "./accessSnapshotFile";
import {
  excludedOf,
  fail,
  isRecord,
  planOf,
  readPrincipals,
  readRows,
  sameShape,
  servicesOf,
  type AccessPrincipals,
  type AccessRows,
  type MethodRow,
  type Plan,
  type Rows,
} from "./accessSnapshotPlan";
import type { TestApp, TestConnection } from "./createTestApp";
import { emitWithAck } from "./socket";

export type { AccessRows };

/** The cell an `inputs` function makes the input of. */
export interface AccessSnapshotRef {
  /** The service's name. */
  readonly service: string;
  /** The method's name. */
  readonly method: string;
  readonly kind: ServiceMethod["kind"];
  /** The row variant, when `rows` names variants for the service whose row the method is about. */
  readonly variant: string | undefined;
  /**
   * The row the cell is about, from `rows`: the method's own service's for
   * an `entry` form, the `of` contract's for a `scope` form, and its own
   * for any other form whose input has an `id`; `undefined` for a method
   * about no row.
   */
  readonly row: string | undefined;
  /** The name of the principal the cell runs as. */
  readonly principal: string;
}

/** Options of {@link snapshotAccessMatrix}. `Fixture` is what `reset` resolves with. */
export interface AccessSnapshotOptions<P, Fixture, Name extends string> {
  /**
   * The callers, by name, or a function of the fixture making them (read
   * again after every reset, for a seed that makes new ids); their names
   * must stay the same. An anonymous caller named `"anonymous"` is added
   * unless one is `null`.
   */
  readonly principals: AccessPrincipals<P, Fixture, Name>;
  /**
   * Empties the database and seeds it, resolving with what the seed made
   * (the fixture): the app's `resetDatabase` (from `./testing/prisma`) and
   * its seed, writing with the untracked client. Called first, and again
   * after every mutation the pipeline did not refuse.
   */
  readonly reset: () => Fixture | PromiseLike<Fixture>;
  /**
   * The row each service's cells are about, by service name: a row id, or
   * named variants (`{ own: p1, other: p2 }`), each a row of its own in the
   * snapshot. It must name every service whose rows a method's form, an
   * entity subscribe or a collection scope of the matrix reads.
   */
  readonly rows: (fixture: Fixture) => AccessRows;
  /**
   * A method's input for one cell, when the generated one will not do;
   * `undefined` to generate it. An input that fails the method's input
   * schema is recorded as `VALIDATION` and never called.
   */
  readonly inputs?: (ref: AccessSnapshotRef, fixture: Fixture) => unknown;
  /** The services whose methods, subscribes and scopes the matrix holds. Default: every service the app serves. */
  readonly services?: readonly AnyService[];
  /** Methods left out, as `<service>.<method>`: those whose outcome is not the same on every run. */
  readonly exclude?: readonly string[];
  /** The test file the snapshot sits beside. Default: the running test's file, from the test runner. */
  readonly file?: string;
}

/** What {@link snapshotAccessMatrix} recorded, and what it did with the snapshot file. */
export interface AccessSnapshotReport {
  /** The snapshot file. */
  readonly path: string;
  /**
   * `"written"`: there was no file; `"unchanged"`: the matrix is the stored
   * one; `"updated"`: the file was rewritten (cells added or removed in a
   * local run, or changes accepted with `QD_UPDATE_ACCESS_SNAPSHOT=1`).
   */
  readonly change: AccessSnapshotChange;
  /** The matrix this run recorded. */
  readonly snapshot: AccessSnapshot;
  /**
   * The cells never called because no input passed the method's input
   * schema (or named the cell's row where its form reads it), as
   * `<row> as <principal>`: recorded as `VALIDATION`, they pin nothing
   * about access. Give their inputs with `inputs`.
   */
  readonly inconclusive: readonly string[];
}

type MethodFunction = (input: unknown) => Promise<unknown>;

/** The outcomes of a mutation the pipeline refused before its handler ran: no reset follows them. */
const REFUSALS: ReadonlySet<string> = new Set(["UNAUTHENTICATED", "FORBIDDEN", "VALIDATION"]);

/** The scope an anonymous caller subscribes to in a `"self"` collection: it has no user id. */
const ANONYMOUS_SCOPE = "anonymous";

/** The recorded outcomes of a section: per row key, then principal name. */
type Cells = Map<string, Map<string, AccessOutcome>>;

/** One run of the matrix: the current fixture, its principals and rows, and the cells so far. */
interface Run<P extends Principal, Fixture> {
  readonly app: TestApp;
  readonly options: AccessSnapshotOptions<P, Fixture, string>;
  readonly served: ReadonlyMap<string, AnyService>;
  readonly plan: Plan;
  fixture: Fixture;
  principals: Map<string, P | null>;
  rows: Rows;
  readonly methods: Cells;
  readonly subscriptions: Cells;
  readonly collections: Cells;
  readonly inconclusive: string[];
}

function record(cells: Cells, key: string, principal: string, outcome: AccessOutcome): void {
  const row = cells.get(key) ?? new Map<string, AccessOutcome>();
  cells.set(key, row.set(principal, outcome));
}

/** Resets the database, and reads the new fixture's principals and rows; their names must not change. */
async function reset<P extends Principal, Fixture>(run: Run<P, Fixture>): Promise<void> {
  const fixture = await run.options.reset();
  const next = {
    principals: readPrincipals(run.options.principals, fixture),
    rows: readRows(run.options.rows(fixture), run.served),
  };
  if (!sameShape(run, next)) {
    fail(
      "principals and rows must name the same principals, services and variants after every reset",
    );
  }
  run.fixture = fixture;
  run.principals = next.principals;
  run.rows = next.rows;
}

function rowIdOf(rows: Rows, service: string, variant: string | undefined): string | undefined {
  return rows.get(service)?.get(variant);
}

/** How a call ended: `"ok"`, or the code of the `QuickdrawError` it failed with; anything else is thrown. */
async function outcomeOf(call: () => Promise<unknown>): Promise<AccessOutcome> {
  try {
    await call();
    return "ok";
  } catch (error) {
    if (error instanceof QuickdrawError) {
      return error.code;
    }
    throw error;
  }
}

/** The outcome an acknowledgement (or one id's result in it) says: `"ok"`, or its error's code. */
function outcomeOfReply(reply: unknown, event: string): AccessOutcome {
  if (isRecord(reply) && reply.ok === true) {
    return "ok";
  }
  const code = isRecord(reply) && isRecord(reply.e) ? reply.e.code : undefined;
  if (typeof code !== "string") {
    throw new Error(`snapshotAccessMatrix: ${event} answered ${JSON.stringify(reply)}`);
  }
  return code as AccessOutcome;
}

/** The input of one method cell: the app's, or a generated one; `undefined` when none is usable. */
async function inputOf<P extends Principal, Fixture>(
  run: Run<P, Fixture>,
  row: MethodRow,
  name: string,
): Promise<{ readonly value: unknown } | undefined> {
  const id =
    row.rowService === undefined ? undefined : rowIdOf(run.rows, row.rowService, row.variant);
  const ref: AccessSnapshotRef = {
    service: row.service.name,
    method: row.method.name,
    kind: row.method.kind,
    variant: row.variant,
    row: id,
    principal: name,
  };
  const given: unknown = await run.options.inputs?.(ref, run.fixture);
  if (given !== undefined) {
    return (await isValidInput(row.method, given)) ? { value: given } : undefined;
  }
  const made = await generatedInput(row.method, id);
  return made === undefined ? undefined : { value: made.input };
}

/** The method a cell calls, through the app's in-process caller acting as `principal`. */
function methodOf(app: TestApp, row: MethodRow, principal: Principal | null): MethodFunction {
  const caller = app.as(principal) as unknown as Readonly<
    Record<string, Readonly<Record<string, MethodFunction>> | undefined>
  >;
  const method = caller[row.service.name]?.[row.method.name];
  if (method === undefined) {
    throw new TypeError(`snapshotAccessMatrix: ${row.service.name} has no ${row.method.name}`);
  }
  return method;
}

/** Calls one method as one principal and records the outcome; resets after a mutation the pipeline let through. */
async function callCell<P extends Principal, Fixture>(
  run: Run<P, Fixture>,
  row: MethodRow,
  name: string,
): Promise<void> {
  const input = await inputOf(run, row, name);
  if (input === undefined) {
    record(run.methods, row.key, name, "VALIDATION");
    run.inconclusive.push(`${row.key} as ${name}`);
    return;
  }
  const method = methodOf(run.app, row, run.principals.get(name) ?? null);
  const outcome = await outcomeOf(() => method(input.value));
  record(run.methods, row.key, name, outcome);
  if (row.method.kind === "mutation" && !REFUSALS.has(outcome)) {
    await reset(run);
  }
}

/** Every entity subscribe of the matrix over `connection`: one `qd:sub` per service, all its variants at once. */
async function subscribeEntities<P extends Principal, Fixture>(
  run: Run<P, Fixture>,
  connection: TestConnection,
  name: string,
): Promise<void> {
  for (const row of run.plan.subscribes) {
    const variants = [...row.keys.keys()];
    const ids = variants.map((variant) => rowIdOf(run.rows, row.service, variant) ?? "");
    const reply: unknown = await emitWithAck(connection.socket, "qd:sub", { s: row.service, ids });
    const results =
      isRecord(reply) && reply.ok === true && Array.isArray(reply.r) ? reply.r : undefined;
    variants.forEach((variant, index) => {
      const outcome = outcomeOfReply(results === undefined ? reply : results[index], "qd:sub");
      record(run.subscriptions, row.keys.get(variant) ?? row.service, name, outcome);
    });
  }
}

/** Every collection scope of the matrix over `connection`, one `qd:col:sub` each. */
async function subscribeScopes<P extends Principal, Fixture>(
  run: Run<P, Fixture>,
  connection: TestConnection,
  name: string,
): Promise<void> {
  const principal = run.principals.get(name) ?? null;
  for (const row of run.plan.scopes) {
    const scope =
      row.anchor === undefined
        ? (principal?.userId ?? ANONYMOUS_SCOPE)
        : (rowIdOf(run.rows, row.anchor, row.variant) ?? "");
    const frame = { s: row.service, c: row.collection, scope, limit: 1 };
    const reply: unknown = await emitWithAck(connection.socket, "qd:col:sub", frame);
    record(run.collections, row.key, name, outcomeOfReply(reply, "qd:col:sub"));
  }
}

/** The code a refused connection carries (its `connect_error` data), if it carries one. */
function refusalCode(error: unknown): AccessOutcome | undefined {
  const data: unknown =
    error instanceof Error ? (error as { readonly data?: unknown }).data : undefined;
  const code = isRecord(data) ? data.code : undefined;
  return typeof code === "string" ? (code as AccessOutcome) : undefined;
}

/** Records `code` for every subscribe and scope of one principal: its socket was refused. */
function refuseAll<P extends Principal, Fixture>(
  run: Run<P, Fixture>,
  name: string,
  code: AccessOutcome,
): void {
  for (const row of run.plan.subscribes) {
    for (const key of row.keys.values()) {
      record(run.subscriptions, key, name, code);
    }
  }
  for (const row of run.plan.scopes) {
    record(run.collections, row.key, name, code);
  }
}

/** The subscribes and scopes of one principal, over a socket of its own. */
async function subscribeAll<P extends Principal, Fixture>(
  run: Run<P, Fixture>,
  name: string,
): Promise<void> {
  if (run.plan.subscribes.length === 0 && run.plan.scopes.length === 0) {
    return;
  }
  let connection: TestConnection;
  try {
    connection = await run.app.connect(run.principals.get(name) ?? null);
  } catch (error) {
    const code = refusalCode(error);
    if (code === undefined) {
      throw error;
    }
    refuseAll(run, name, code);
    return;
  }
  try {
    await subscribeEntities(run, connection, name);
    await subscribeScopes(run, connection, name);
  } finally {
    connection.close();
  }
}

function rowsOf(cells: Cells): Record<string, AccessSnapshotRow> {
  return Object.fromEntries([...cells].map(([key, row]) => [key, Object.fromEntries(row)]));
}

/** The snapshot of a finished run, with the principals as the first fixture made them. */
function snapshotOf<P extends Principal, Fixture>(
  run: Run<P, Fixture>,
  principals: ReadonlyMap<string, P | null>,
): AccessSnapshot {
  const recorded = [...principals].map(([name, principal]): [string, AccessSnapshotPrincipal] => [
    name,
    principal === null ? null : { kind: principal.kind ?? null },
  ]);
  return {
    version: 1,
    principals: Object.fromEntries(recorded),
    methods: rowsOf(run.methods),
    subscriptions: rowsOf(run.subscriptions),
    collections: rowsOf(run.collections),
    excluded: run.plan.excluded,
  };
}

/** The options, checked as far as they can be before the first reset. */
function checkOptions(options: unknown): void {
  if (
    !isRecord(options) ||
    typeof options.reset !== "function" ||
    typeof options.rows !== "function"
  ) {
    fail("pass { principals, reset, rows }: reset() seeds the rows, rows(fixture) names them");
  }
  if (options.inputs !== undefined && typeof options.inputs !== "function") {
    fail("inputs must be a function of the cell and the fixture");
  }
}

/**
 * Records who may call what through `app` (from `createTestApp`): every
 * method of `services` (default: every service the app serves), each
 * entity subscribe (`qd:sub`) and each collection scope (`qd:col:sub`), as
 * every principal and anonymously, against the rows `reset` seeds, and
 * compares the matrix with the snapshot file beside the test
 * (`__access__/<test file>.json`, keys sorted: commit it).
 *
 * - A missing file is written. Under CI (`CI=1` or `CI=true`) it fails
 *   instead: a snapshot that writes itself pins nothing.
 * - A cell whose outcome changed fails, naming the row (method and
 *   variant), the principal and both outcomes, and whether the change opens
 *   or closes access. Accept the changes with `QD_UPDATE_ACCESS_SNAPSHOT=1`,
 *   which rewrites the file (never under CI).
 * - Cells added or removed (a new method, principal or exclusion) rewrite
 *   the file locally, and fail under CI.
 *
 * Outcomes are exact: `"ok"`, or the error code. Each principal's `kind` is
 * recorded too, and a changed kind fails like a cell. A cell whose input
 * failed the method's input schema is `VALIDATION`, never called, and
 * listed in the report's `inconclusive`. Leave out methods whose outcome is
 * not the same on every run with `exclude`. One snapshot per test file.
 *
 * @example
 * const report = await snapshotAccessMatrix(app, { principals, reset, rows });
 * expect(report.inconclusive).toEqual([]);
 */
export async function snapshotAccessMatrix<
  S extends readonly AnyService[],
  Fixture,
  const Name extends string,
>(
  app: TestApp<S>,
  options: AccessSnapshotOptions<PrincipalOfServices<S>, Fixture, Name>,
): Promise<AccessSnapshotReport> {
  checkOptions(options);
  const path = snapshotPathOf(options.file);
  const generic = app as unknown as TestApp;
  const served = generic.server.dispatcher.registry.services;
  const services = servicesOf(generic, options.services);
  const excluded = excludedOf(services, options.exclude);
  const fixture = await options.reset();
  const principals = readPrincipals<PrincipalOfServices<S>, Fixture>(options.principals, fixture);
  const rows = readRows(options.rows(fixture), served);
  const run: Run<PrincipalOfServices<S>, Fixture> = {
    app: generic,
    options: options as AccessSnapshotOptions<PrincipalOfServices<S>, Fixture, string>,
    served,
    plan: planOf(services, excluded, rows),
    fixture,
    principals,
    rows,
    methods: new Map(),
    subscriptions: new Map(),
    collections: new Map(),
    inconclusive: [],
  };
  for (const name of principals.keys()) {
    await subscribeAll(run, name);
    for (const row of [...run.plan.queries, ...run.plan.mutations]) {
      await callCell(run, row, name);
    }
  }
  const snapshot = snapshotOf(run, principals);
  const change = settleSnapshot(path, snapshot, run.inconclusive);
  return { path, change, snapshot, inconclusive: run.inconclusive };
}
