// The Prisma operation table (RFC 0003 section 5.2): for each write, how the
// tracking hook learns the ids it touched, the fields it set, and the
// interested columns' values before and after, and what that costs.
//
// | Operation           | Recorded as | Ids and values from                | Extra statements             |
// |---------------------|-------------|------------------------------------|------------------------------|
// | create              | create      | the result                         | none                         |
// | upsert              | create, or  | the result; old values from a read | one read, only when `update` |
// |                     | update when | that also says the row existed     | sets an interested column    |
// |                     | read found  |                                    |                              |
// | update              | update      | the result; old values from a read | one read, only when `data`   |
// |                     |             |                                    | sets an interested column    |
// | delete              | delete      | the result (the deleted row)       | none                         |
// | createMany          | create      | rewritten to createManyAndReturn   | none                         |
// | updateMany          | update      | rewritten to updateManyAndReturn   | as updateManyAndReturn       |
// | createManyAndReturn | create      | the result                         | none                         |
// | updateManyAndReturn | update      | the result; old values from a read | one read, only when `data`   |
// |                     |             |                                    | sets an interested column    |
// | deleteMany          | delete      | a read with the same `where`       | one read                     |
//
// `fields` are the keys of `data` (for upsert, of `update` when the row
// existed, of `create` when it did not, and of both when no read told; such
// a create is marked `mayHaveExisted`).
// When a `select` (or `omit`) would hide the `id` or an interested column,
// the hook adds it and strips it from the result again, so the caller gets
// exactly what it asked for. Reads go through the open interactive
// transaction's client, so they see its uncommitted rows. A `deleteMany`
// with a `limit` deletes exactly the rows its read found.
//
// Inside an array-form `$transaction([...])` an operation cannot be replaced
// by another one, so `createMany` and `updateMany` run as they are there:
// `updateMany` reads its ids first, and `createMany` is tracked only when
// every row it creates has an explicit `id`. A batch has no transaction
// client, so every read made first there (`deleteMany`'s and `updateMany`'s
// ids, an `update`'s old values) runs on the root client, outside the batch,
// and misses what the batch's earlier statements changed: a development
// warning says so once per model and operation.
//
// A write that changed nothing records nothing (finding F7.2 of the
// quickdraw-chat review), so no frame, delta, topic change, `refreshEntry`
// or `affects` hop follows it. It is decided from what the hook holds, and
// where it holds too little the write is recorded as before:
//
// - a write that matched no row (`updateMany`, `updateManyAndReturn` or
//   `deleteMany`; in a batch, an `updateMany` answering count 0);
// - a `data` (or an upsert's `update`) with nothing to write, `{}` or only
//   `undefined` values, for which Prisma writes nothing at all;
// - an `update`, an `updateMany` and an upsert that found its row, when
//   every column `data` sets is an interested one, read before the write,
//   and holds the same value after it. Prisma still moves an `@updatedAt`
//   column on such a write; like every `@updatedAt` column, it is not a
//   field the write set, and is not signalled. A write that sets any other
//   column is recorded: its old value was never read.
//
// An upsert whose `update` sets nothing changes a row only when it creates
// one, and nothing it returns tells which it did. Its read replaces it:
// `findUnique` with its `where` and selection answers for a row that exists
// (one statement, as the upsert was), and only a missing row runs the upsert
// after it, recorded as a create (one statement more). In a batch, where no
// operation can be replaced, it is still recorded as a create that may have
// found its row.

import { quietly } from "../server/devWarnings";
import type { WriteRecord } from "../server/uow/types";
import type { WriteTracker } from "../server/uow/unitOfWork";
import { findNestedWrites } from "./nested";

/** A Prisma operation's arguments. */
export type Args = Readonly<Record<string, unknown>>;

/** A row a Prisma operation returned. */
export type Row = Readonly<Record<string, unknown>>;

type Values = Readonly<Record<string, unknown>>;

/** The model methods the hook's own queries use. */
export interface Delegate {
  findMany(args: Args): Promise<Row[]>;
  findUnique(args: Args): Promise<Row | null>;
  count(args: Args): Promise<number>;
  createManyAndReturn(args: Args): Promise<Row[]>;
  updateManyAndReturn(args: Args): Promise<Row[]>;
}

/** What every operation handler shares. */
export interface Runtime {
  readonly tracker: WriteTracker;
  /** The model's delegate on the open interactive transaction's client, or else the root client's. */
  delegate(model: string): Delegate;
  interestOf(model: string): readonly string[];
  /** Models whose writes run untracked: no usable `id` column. */
  readonly untracked: Set<string>;
}

/** One write operation, as the hook received it. */
export interface Operation {
  readonly runtime: Runtime;
  /** The model, named as the client names it: `"task"`. */
  readonly model: string;
  /** The Prisma operation: `"deleteMany"`. */
  readonly operation: string;
  readonly args: Args;
  readonly query: (args: Args) => Promise<unknown>;
}

/**
 * Thrown when the hook's own read failed validation before the write ran;
 * the hook then runs the write as the caller wrote it (`runUntracked`).
 */
export class Untrackable extends Error {
  override readonly name = "Untrackable";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidationError(error: unknown): boolean {
  return error instanceof Error && error.name === "PrismaClientValidationError";
}

/** Stops tracking `model` for the life of the process, and says why once. */
function untrack(op: Operation, reason: string): void {
  if (op.runtime.untracked.has(op.model)) {
    return;
  }
  op.runtime.untracked.add(op.model);
  op.runtime.tracker.logger.warn(
    `Writes to ${op.model} are not tracked: ${reason}. Tracked models need a string id column named "id"`,
    { category: "quickdraw.writes", model: op.model },
  );
}

/**
 * Runs the operation as the caller wrote it, after a query the hook built
 * failed validation (a model without an `id` column, or an interested column
 * it does not have). The hook stops tracking the model only when the
 * caller's own query then works: an error in the caller's arguments is
 * theirs, and reaches them.
 */
export async function runUntracked(op: Operation, reason: string): Promise<unknown> {
  const result = await op.query(op.args);
  untrack(op, reason);
  return result;
}

function idOf(row: Row): string | undefined {
  const { id } = row;
  if (typeof id === "string") {
    return id;
  }
  return typeof id === "number" || typeof id === "bigint" ? String(id) : undefined;
}

function pick(row: Row, columns: readonly string[]): Values | undefined {
  const present = columns.filter((column) => Object.hasOwn(row, column));
  return present.length === 0
    ? undefined
    : Object.fromEntries(present.map((column) => [column, row[column]]));
}

function keysOf(data: unknown): string[] {
  if (Array.isArray(data)) {
    return [...new Set(data.flatMap((item) => keysOf(item)))];
  }
  return isRecord(data) ? Object.keys(data) : [];
}

function rowsOf(result: unknown): Row[] {
  if (Array.isArray(result)) {
    return result.filter(isRecord);
  }
  return isRecord(result) ? [result] : [];
}

/** The keys of `data` Prisma writes: those whose value is not `undefined`. */
function writtenKeys(data: unknown): string[] {
  return isRecord(data)
    ? Object.entries(data)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key)
    : [];
}

/** True for a `data` Prisma writes nothing for: an object with no key whose value is set. */
export function writesNothing(data: unknown): boolean {
  return isRecord(data) && writtenKeys(data).length === 0;
}

/** The text of a value object such as Prisma's `Decimal`, or `undefined` when it has none of its own. */
function textOf(value: object): string | undefined {
  const { toString } = value as { readonly toString?: unknown };
  return typeof toString === "function" && toString !== Object.prototype.toString
    ? String(value)
    : undefined;
}

/**
 * Whether two values a column held are the same: primitives, `Date`s by
 * their time, bytes, JSON values whatever their key order, and value objects
 * of one class (Prisma's `Decimal`) by their text. Anything else counts as
 * different, so a write that cannot be compared is recorded.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && sameItems(a, b);
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    return a instanceof Uint8Array && b instanceof Uint8Array && sameItems(a, b);
  }
  return sameObject(a, b);
}

function sameItems(a: ArrayLike<unknown>, b: ArrayLike<unknown>): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (!sameValue(a[index], b[index])) {
      return false;
    }
  }
  return true;
}

/** Two objects: a JSON object by its keys whatever their order, a value object by its text. */
function sameObject(a: object, b: object): boolean {
  const prototype = Object.getPrototypeOf(a) as unknown;
  if (prototype !== Object.getPrototypeOf(b)) {
    return false;
  }
  if (prototype !== Object.prototype && prototype !== null) {
    const text = textOf(a);
    return text !== undefined && text === textOf(b);
  }
  const left = a as Values;
  const right = b as Values;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
  );
}

/**
 * True when an update recorded as `write` certainly changed no column: every
 * column `data` sets is an interested one, whose value was read before the
 * write and is the same after it.
 */
function unchanged(op: Operation, data: unknown, write: WriteRecord): boolean {
  const { before, after } = write;
  const keys = writtenKeys(data);
  if (before === undefined || after === undefined || keys.length === 0) {
    return false;
  }
  const interest = op.runtime.interestOf(op.model);
  return keys.every(
    (key) =>
      interest.includes(key) &&
      Object.hasOwn(before, key) &&
      Object.hasOwn(after, key) &&
      sameValue(before[key], after[key]),
  );
}

/** The updates of `writes` that changed a column, or may have: see {@link unchanged}. */
function changedOnly(op: Operation, data: unknown, writes: readonly WriteRecord[]): WriteRecord[] {
  return writes.filter((write) => !unchanged(op, data, write));
}

/** Counts a statement the hook runs past itself (`op.query`), and hands it to the development checks. */
function countOwn(op: Operation, operation: string, args: Args): void {
  op.runtime.tracker.countStatement();
  op.runtime.tracker.observe({ model: op.model, operation, args });
}

function warnNested(op: Operation, data: unknown): void {
  for (const { field, operation } of findNestedWrites(data)) {
    op.runtime.tracker.warn({
      kind: "nested-write",
      subject: `${op.model}.${field}.${operation}`,
      message: `A nested write (${op.model}.${field}: { ${operation} }) is not tracked; only the ${op.model} row is. Write related rows through their own model`,
      meta: { model: op.model, field, operation },
    });
  }
}

/** The interested columns `data` sets. */
function touchedInterest(op: Operation, data: unknown): string[] {
  const keys = new Set(keysOf(data));
  return op.runtime.interestOf(op.model).filter((column) => keys.has(column));
}

/** `args` with `columns` added to its `select`, or no longer omitted, and the columns that were added. */
function widen(args: Args, columns: readonly string[]): { args: Args; added: string[] } {
  const { select, omit } = args;
  if (isRecord(select)) {
    const added = columns.filter((column) => select[column] !== true);
    const widened = { ...select, ...Object.fromEntries(added.map((column) => [column, true])) };
    return { args: added.length === 0 ? args : { ...args, select: widened }, added };
  }
  if (isRecord(omit)) {
    const added = columns.filter((column) => omit[column] === true);
    const widened = { ...omit, ...Object.fromEntries(added.map((column) => [column, false])) };
    return { args: added.length === 0 ? args : { ...args, omit: widened }, added };
  }
  return { args, added: [] };
}

function strip(result: unknown, added: readonly string[]): unknown {
  const without = (row: unknown): unknown =>
    isRecord(row)
      ? Object.fromEntries(Object.entries(row).filter(([key]) => !added.includes(key)))
      : row;
  return Array.isArray(result) ? result.map(without) : without(result);
}

/**
 * Runs the operation with the `id` and interested columns in its result,
 * and returns the caller's result plus the rows to record. When adding them
 * fails validation (a model without an `id` column), the operation runs as
 * the caller wrote it and its rows are not recorded.
 */
async function runWidened(op: Operation): Promise<{ result: unknown; rows: Row[] }> {
  const { args, added } = widen(op.args, ["id", ...op.runtime.interestOf(op.model)]);
  if (added.length === 0) {
    const result = await op.query(op.args);
    return { result, rows: rowsOf(result) };
  }
  let result: unknown;
  try {
    result = await op.query(args);
  } catch (error) {
    if (!isValidationError(error)) {
      throw error;
    }
    return { result: await runUntracked(op, "selecting its id failed"), rows: [] };
  }
  return { result: strip(result, added), rows: rowsOf(result) };
}

/**
 * Warns once per model and operation that a read made first inside an
 * array-form `$transaction` runs on the root client: an array-form batch
 * has no transaction client to read through, so the read does not see what
 * the batch's earlier statements changed.
 */
function warnBatchRead(op: Operation): void {
  if (!op.runtime.tracker.inBatch()) {
    return;
  }
  op.runtime.tracker.warn({
    kind: "batch-read",
    subject: `${op.model}.${op.operation}`,
    message: `${op.operation} on ${op.model} inside an array-form $transaction reads its rows first on the root client, outside the batch, so rows the batch's earlier statements changed may be missed; use an interactive transaction to read inside it`,
    meta: { model: op.model, operation: op.operation },
  });
}

/**
 * Reads `columns` of the rows `where` matches, by id, through the transaction
 * when one is open. The read is the tracker's own, not the app's, so the
 * development checks of statements leave it alone.
 */
async function readBefore(
  op: Operation,
  where: unknown,
  columns: readonly string[],
  options: { readonly unique: boolean; readonly take?: unknown },
): Promise<Map<string, Values>> {
  warnBatchRead(op);
  const select = Object.fromEntries(["id", ...columns].map((column) => [column, true]));
  const delegate = op.runtime.delegate(op.model);
  let rows: Row[];
  try {
    if (options.unique) {
      const row = await quietly(() => delegate.findUnique({ where, select }));
      rows = row === null ? [] : [row];
    } else {
      rows = await quietly(() =>
        delegate.findMany({
          where,
          select,
          ...(options.take === undefined ? {} : { take: options.take }),
        }),
      );
    }
  } catch (error) {
    if (isValidationError(error)) {
      throw new Untrackable("reading its id failed", { cause: error });
    }
    throw error;
  }
  const before = new Map<string, Values>();
  for (const row of rows) {
    const id = idOf(row);
    if (id !== undefined) {
      before.set(id, pick(row, columns) ?? {});
    }
  }
  return before;
}

function writesOf(
  op: Operation,
  kind: WriteRecord["op"],
  rows: readonly Row[],
  fields: readonly string[],
  before?: ReadonlyMap<string, Values>,
): WriteRecord[] {
  const interest = op.runtime.interestOf(op.model);
  const writes: WriteRecord[] = [];
  for (const row of rows) {
    const id = idOf(row);
    if (id === undefined) {
      untrack(op, "its rows have no id");
      return [];
    }
    const values = pick(row, interest);
    const old = kind === "delete" ? values : before?.get(id);
    const after = kind === "delete" ? undefined : values;
    writes.push({
      model: op.model,
      id,
      op: kind,
      fields,
      ...(old === undefined || Object.keys(old).length === 0 ? {} : { before: old }),
      ...(after === undefined ? {} : { after }),
    });
  }
  return writes;
}

function record(op: Operation, writes: readonly WriteRecord[]): void {
  op.runtime.tracker.record(writes);
}

async function create(op: Operation): Promise<unknown> {
  warnNested(op, op.args.data);
  const { result, rows } = await runWidened(op);
  record(op, writesOf(op, "create", rows, keysOf(op.args.data)));
  return result;
}

/** The selection of a read that returns what `args` (an upsert's) would: its `select`, `include` and `omit`. */
function selectionOf(args: Args): Args {
  return Object.fromEntries(
    ["select", "include", "omit"]
      .filter((key) => args[key] !== undefined)
      .map((key) => [key, args[key]]),
  );
}

/**
 * An upsert whose `update` sets nothing (see the top of this file): the
 * read that tells whether its row exists takes its place, and answers it
 * when the row is there; only a missing row runs the upsert.
 */
async function upsertWithoutUpdate(op: Operation): Promise<unknown> {
  warnNested(op, op.args.create);
  const { args, added } = widen(op.args, ["id", ...op.runtime.interestOf(op.model)]);
  let found: Row | null;
  try {
    // Through the hook, which counts it as this call's one statement.
    found = await op.runtime
      .delegate(op.model)
      .findUnique({ where: op.args.where, ...selectionOf(args) });
  } catch (error) {
    if (!isValidationError(error)) {
      throw error;
    }
    // The hook counted the read that failed; the upsert runs in its place.
    return runUntracked(op, "reading its id failed");
  }
  if (found !== null) {
    // Prisma writes nothing to a row that exists when `update` sets nothing: no change.
    return strip(found, added);
  }
  countOwn(op, op.operation, op.args);
  const { result, rows } = await runWidened(op);
  // Created, unless another transaction created the row in between: then it may have existed.
  const writes = writesOf(op, "create", rows, keysOf(op.args.create));
  record(
    op,
    writes.map((write) => ({ ...write, mayHaveExisted: true as const })),
  );
  return result;
}

async function upsert(op: Operation): Promise<unknown> {
  if (writesNothing(op.args.update) && !op.runtime.tracker.inBatch()) {
    return upsertWithoutUpdate(op);
  }
  warnNested(op, op.args.create);
  warnNested(op, op.args.update);
  const touched = touchedInterest(op, op.args.update);
  // Reading the interested columns first also tells whether the row existed.
  const before =
    touched.length === 0
      ? undefined
      : await readBefore(op, op.args.where, touched, { unique: true });
  const { result, rows } = await runWidened(op);
  if (before !== undefined && before.size > 0) {
    const writes = writesOf(op, "update", rows, keysOf(op.args.update), before);
    record(op, changedOnly(op, op.args.update, writes));
  } else if (before === undefined) {
    // Nothing read: the row may have existed, and been updated.
    const writes = writesOf(op, "create", rows, keysOf([op.args.create, op.args.update]));
    record(
      op,
      writes.map((write) => ({ ...write, mayHaveExisted: true as const })),
    );
  } else {
    record(op, writesOf(op, "create", rows, keysOf(op.args.create)));
  }
  return result;
}

async function update(op: Operation): Promise<unknown> {
  if (writesNothing(op.args.data)) {
    // Prisma only reads the row (and answers NOT_FOUND without one): nothing to record.
    return op.query(op.args);
  }
  warnNested(op, op.args.data);
  const touched = touchedInterest(op, op.args.data);
  const before =
    touched.length === 0
      ? undefined
      : await readBefore(op, op.args.where, touched, { unique: true });
  const { result, rows } = await runWidened(op);
  const writes = writesOf(op, "update", rows, keysOf(op.args.data), before);
  record(op, changedOnly(op, op.args.data, writes));
  return result;
}

async function remove(op: Operation): Promise<unknown> {
  const { result, rows } = await runWidened(op);
  record(op, writesOf(op, "delete", rows, []));
  return result;
}

async function createManyAndReturn(op: Operation): Promise<unknown> {
  const { result, rows } = await runWidened(op);
  record(op, writesOf(op, "create", rows, keysOf(op.args.data)));
  return result;
}

async function updateManyAndReturn(op: Operation): Promise<unknown> {
  if (writesNothing(op.args.data)) {
    // Prisma only reads the rows `where` matches: nothing to record.
    return op.query(op.args);
  }
  const touched = touchedInterest(op, op.args.data);
  const before =
    touched.length === 0
      ? undefined
      : await readBefore(op, op.args.where, touched, { unique: false });
  const { result, rows } = await runWidened(op);
  // Rows it matched none of record nothing; neither do rows it set to what they held.
  const writes = writesOf(op, "update", rows, keysOf(op.args.data), before);
  record(op, changedOnly(op, op.args.data, writes));
  return result;
}

/** `createMany` inside an array-form transaction: tracked when every row names its id. */
async function createManyInBatch(op: Operation): Promise<unknown> {
  const items = (Array.isArray(op.args.data) ? op.args.data : [op.args.data]).filter(isRecord);
  const result = await op.query(op.args);
  const rows = items.filter((item) => idOf(item) !== undefined);
  if (rows.length === items.length) {
    record(op, writesOf(op, "create", rows, keysOf(op.args.data)));
  } else {
    op.runtime.tracker.warn({
      kind: "batch-create-many",
      subject: op.model,
      message: `createMany on ${op.model} inside an array-form $transaction cannot report the rows it created, so they are not tracked; give each row an id, or use an interactive transaction`,
      meta: { model: op.model },
    });
  }
  return result;
}

/**
 * `updateMany` inside an array-form transaction: its ids are read first,
 * before the batch runs. With a `limit`, every row the read found is
 * recorded, which may be more rows than were updated.
 */
async function updateManyInBatch(op: Operation): Promise<unknown> {
  if (writesNothing(op.args.data)) {
    return op.query(op.args);
  }
  const before = await readBefore(op, op.args.where, touchedInterest(op, op.args.data), {
    unique: false,
  });
  const result = await op.query(op.args);
  // Only a count comes back: 0 means it updated nothing, whatever the read found.
  if (isRecord(result) && result.count === 0) {
    return result;
  }
  const rows = [...before.keys()].map((id) => ({ id }));
  record(op, writesOf(op, "update", rows, keysOf(op.args.data), before));
  return result;
}

/**
 * `createMany` and `updateMany` outside a batch: the `...AndReturn` form,
 * through the transaction's client when one is open, which the hook then
 * records like any other call of it.
 */
async function rewrite(
  op: Operation,
  run: (delegate: Delegate, args: Args) => Promise<Row[]>,
): Promise<unknown> {
  let rows: Row[];
  try {
    rows = await run(op.runtime.delegate(op.model), { ...op.args, select: { id: true } });
  } catch (error) {
    if (!isValidationError(error)) {
      throw error;
    }
    op.runtime.tracker.countStatement();
    return runUntracked(op, "selecting its id failed");
  }
  return { count: rows.length };
}

function createMany(op: Operation): Promise<unknown> {
  if (op.runtime.tracker.inBatch()) {
    return createManyInBatch(op);
  }
  return rewrite(op, (delegate, args) => delegate.createManyAndReturn(args));
}

function updateMany(op: Operation): Promise<unknown> {
  if (op.runtime.tracker.inBatch()) {
    return updateManyInBatch(op);
  }
  if (writesNothing(op.args.data)) {
    // As it is: Prisma writes nothing and answers count 0, which the rewrite would not.
    return op.query(op.args);
  }
  return rewrite(op, (delegate, args) => delegate.updateManyAndReturn(args));
}

async function deleteMany(op: Operation): Promise<unknown> {
  const { where, limit } = op.args;
  const interest = op.runtime.interestOf(op.model);
  const before = await readBefore(op, where, interest, { unique: false, take: limit });
  const ids = [...before.keys()];
  // With a limit, which rows go is up to the database: delete the rows read.
  const args =
    limit === undefined
      ? op.args
      : { ...op.args, where: { AND: [where ?? {}, { id: { in: ids } }] } };
  const result = await op.query(args);
  const rows = ids.map((id) => ({ id, ...before.get(id) }));
  record(op, writesOf(op, "delete", rows, []));
  return result;
}

/**
 * The write operations the hook tracks, by Prisma operation name. Every
 * other operation passes through untouched.
 */
export const WRITE_OPERATIONS: Readonly<Record<string, (op: Operation) => Promise<unknown>>> =
  Object.freeze({
    create,
    upsert,
    update,
    delete: remove,
    createMany,
    createManyAndReturn,
    updateMany,
    updateManyAndReturn,
    deleteMany,
  });

/**
 * Whether a tracked operation hands its work to another one, which then
 * counts the statement (`createMany` and `updateMany` outside a batch, an
 * `upsert` whose `update` sets nothing outside a batch: its read): the hook
 * counts every other operation itself.
 */
export function delegates(runtime: Runtime, operation: string, args: Args | undefined): boolean {
  if (runtime.tracker.inBatch()) {
    return false;
  }
  switch (operation) {
    case "createMany":
      return true;
    case "updateMany":
      return !writesNothing(args?.data);
    case "upsert":
      return writesNothing(args?.update);
    default:
      return false;
  }
}
