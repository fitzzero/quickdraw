// `trackPrisma` (RFC 0003 sections 5.2 and 5.4): wraps an app's Prisma
// client so every write made through it is recorded into the unit of work it
// runs in. In 4.1 only `BaseService.create/update/delete` were observed
// (4.1 `src/server/BaseService.ts:769-827`); a raw `prisma.task.update`
// was invisible, and every live update needed a hand-written emit.
//
// Client extensions, all public Prisma API:
//
// 1. a `query` hook on every operation records writes (`operations.ts`) and
//    counts statements. The client is extended with it twice, over two
//    runtimes (`createRuntimes`): the root client's operations run one,
//    and interactive transactions begin on the other (`transactional`), so
//    their clients' operations run that one. Prisma itself carries which
//    hook an operation runs, through its lazy promises and batches alike,
//    so no marker is set per call and no Prisma internal is read. The root
//    client's work inside a transaction's callback runs outside the
//    transaction, on a connection of its own: its reads and writes go
//    through the root client, and its writes skip the transaction's frame;
//    an array-form batch's operations, made on the root client, are the
//    batch's own;
// 2. a `client` extension replaces `$transaction`, so writes inside a
//    transaction are buffered and join the unit of work only once it commits.
//    Transactions are found through that wrapper and `AsyncLocalStorage`.
//    The transaction's client is handed to its callback behind a proxy whose
//    `$transaction` takes the same path (`nestable`): on Prisma 7 a
//    transaction begun on it is nested, a savepoint, and its writes join the
//    transaction around it only once the savepoint is released; one begun on
//    the root client commits on its own, wherever it is begun.
//
// Make it the last extension applied: an extension added after it still
// runs outside transactions, but not on a transaction's client.
//
// The storage adapter's `nullable` and `trackable` read the one Prisma
// internal used here, the schema text the client keeps
// (`_engineConfig.inlineSchema`, `schemaText.ts`). Without it they ask the
// database, as before: a statement Prisma refuses, which it logs as an error.

import { consoleLogger, type Logger } from "../contract/logger";
import { quietly } from "../server/devWarnings";
import {
  createInterestRegistry,
  createLinkRegistry,
  modelKey,
  STORAGE_KEY,
  storageOf,
  type CountArgs,
  type FindManyArgs,
  type StorageAdapter,
} from "../server/storage";
import { createWriteTracker, type WriteTracker } from "../server/uow/unitOfWork";
import {
  delegates,
  idOf,
  runUntracked,
  Untrackable,
  WRITE_OPERATIONS,
  type Args,
  type Delegate,
  type Operation,
  type Runtime,
} from "./operations";
import { prismaSchemaOf, type PrismaSchemaFacts } from "./schemaText";
import type { Tracked } from "./tracked";

/** Options of {@link trackPrisma}. */
export interface TrackPrismaOptions {
  /**
   * Interested columns per model, whose values writes report in `before`
   * and `after`: `{ task: ["projectId", "status"] }`. The framework adds the
   * columns its collections and access policies need with
   * `storage.registerInterest`; this is for the app's own sinks.
   */
  readonly interest?: Readonly<Record<string, readonly string[]>>;
  /**
   * Receives warnings until a dispatcher is created with this client; then
   * the dispatcher's logger does. Default: the console logger.
   */
  readonly logger?: Logger;
  /**
   * Warn about writes outside any unit of work and about nested writes.
   * Default: on unless `NODE_ENV` is `"production"`.
   */
  readonly development?: boolean;
}

/** The part of a Prisma client `trackPrisma` relies on: client extensions. */
export interface PrismaClientLike {
  $extends(extension: never): unknown;
}

/** The client as `trackPrisma` calls it. */
interface ExtendableClient {
  $extends(extension: object): ExtendedClient;
}

interface ExtendedClient extends ExtendableClient {
  $transaction(arg: unknown, options?: unknown): Promise<unknown>;
}

/** What a query extension's `$allOperations` hook receives. */
interface QueryHookArgs {
  readonly model?: string;
  readonly operation: string;
  readonly args: Args | undefined;
  readonly query: (args: Args | undefined) => Promise<unknown>;
}

function isClient(value: unknown): value is ExtendableClient {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof Reflect.get(value, "$extends") === "function"
  );
}

function delegateOf(client: unknown, model: string): Delegate {
  const delegate: unknown =
    typeof client === "object" && client !== null ? Reflect.get(client, model) : undefined;
  if (typeof delegate !== "object" || delegate === null) {
    throw new TypeError(`The tracked Prisma client has no model "${model}"`);
  }
  return delegate as Delegate;
}

/** Counts one statement the hook is about to run, and hands a model's to the development checks. */
function count(
  runtime: Runtime,
  model: string | undefined,
  operation: string,
  args: Args | undefined,
): void {
  runtime.tracker.countStatement();
  if (model !== undefined) {
    runtime.observe({ model: modelKey(model), operation, args });
  }
}

/** What both of a tracked client's runtimes share. */
type SharedRuntime = Pick<Runtime, "tracker" | "interestOf" | "linksOf" | "untracked">;

/**
 * The runtimes of a tracked client's two hooks. The root client's
 * operations run outside every interactive transaction, even inside one's
 * callback, on a connection of their own: the hook's own queries go through
 * the root client, and their writes skip every open transaction frame,
 * unless an array-form batch runs them as its own. A transaction client's
 * run in the innermost open transaction.
 */
function createRuntimes(
  shared: SharedRuntime,
  root: () => unknown,
): { readonly root: Runtime; readonly transaction: Runtime } {
  const { tracker } = shared;
  const outside = () => ({ outsideTransactions: !tracker.inBatch() });
  return {
    root: {
      ...shared,
      delegate: (model) => delegateOf(root(), model),
      record: (writes) => tracker.record(writes, outside()),
      observe: (statement) => tracker.observe(statement, outside()),
    },
    transaction: {
      ...shared,
      delegate: (model) => delegateOf(tracker.transactionClient() ?? root(), model),
      record: (writes) => tracker.record(writes),
      observe: (statement) => tracker.observe(statement),
    },
  };
}

function createHook(runtime: Runtime) {
  return async function track({ model, operation, args, query }: QueryHookArgs): Promise<unknown> {
    const handler = model === undefined ? undefined : WRITE_OPERATIONS[operation];
    if (model === undefined || handler === undefined || runtime.untracked.has(modelKey(model))) {
      count(runtime, model, operation, args);
      return query(args);
    }
    if (!delegates(runtime, operation, args)) {
      count(runtime, model, operation, args);
    }
    const op: Operation = { runtime, model: modelKey(model), operation, args: args ?? {}, query };
    try {
      return await handler(op);
    } catch (error) {
      if (error instanceof Untrackable) {
        return runUntracked(op, error.message);
      }
      throw error;
    }
  };
}

/**
 * An interactive transaction's client as its callback gets it: Prisma's own,
 * except that its `$transaction` (Prisma 7 runs one as a nested transaction,
 * a savepoint of this one) goes through {@link transaction} too. Its writes
 * then join this transaction only once the savepoint is released, and are
 * dropped when it rolls back while this one goes on to commit; the client
 * the nested callback gets is wrapped the same way. A client without
 * `$transaction` is handed on as it is.
 */
function nestable(tracker: WriteTracker, client: unknown): unknown {
  if (
    (typeof client !== "object" && typeof client !== "function") ||
    client === null ||
    typeof Reflect.get(client, "$transaction") !== "function"
  ) {
    return client;
  }
  const own = client as ExtendedClient;
  return new Proxy(own, {
    get(target, property) {
      return property === "$transaction"
        ? (arg: unknown, options?: unknown) => transaction(tracker, own, arg, options, true)
        : Reflect.get(target, property);
    },
  });
}

/**
 * `$transaction`, in both forms, inside a transaction frame of the tracker,
 * opened on `base`: a hooked client (`transactional` for the interactive
 * form, whose client then carries the transaction clients' hook), or for a
 * `nested` transaction the client of the transaction around it.
 */
async function transaction(
  tracker: WriteTracker,
  base: ExtendedClient,
  arg: unknown,
  options: unknown,
  nested: boolean,
): Promise<unknown> {
  const interactive = typeof arg === "function";
  const frame = tracker.openTransaction(interactive ? "interactive" : "batch", { nested });
  try {
    const result = interactive
      ? await base.$transaction((client: unknown) => {
          frame.setClient(client);
          return frame.run(() => (arg as (client: unknown) => unknown)(nestable(tracker, client)));
        }, options)
      : await frame.run(() => base.$transaction(arg, options));
    frame.commit();
    return result;
  } catch (error) {
    frame.rollback();
    throw error;
  }
}

/**
 * `StorageAdapter.nullable`: what the client's schema says (`Type?`), with
 * no statement (`schemaText.ts`). A column the schema does not answer for is
 * probed: Prisma validates a filter against the schema before sending it,
 * and refuses `{ column: null }` on a required column (a client that logs
 * errors prints that refusal). The probe's answer is kept for the life of the
 * client: one statement per optional column, none for a required one.
 */
function createNullability(
  delegate: (model: string) => Delegate,
  schema: PrismaSchemaFacts | undefined,
): (model: string, column: string) => Promise<boolean> {
  const known = new Map<string, boolean>();
  return async (model, column) => {
    const declared = schema?.nullable(model, column);
    if (declared !== undefined) {
      return declared;
    }
    const key = `${modelKey(model)}\u0000${column}`;
    const kept = known.get(key);
    if (kept !== undefined) {
      return kept;
    }
    let nullable = true;
    try {
      await quietly(() => delegate(modelKey(model)).count({ where: { [column]: null } }));
    } catch (error) {
      if (!(error instanceof Error && error.name === "PrismaClientValidationError")) {
        throw error;
      }
      nullable = false;
    }
    known.set(key, nullable);
    return nullable;
  };
}

/**
 * `StorageAdapter.trackable`: whether the tracker can key `model`'s writes,
 * that is whether its rows have an `id`, as the client's schema says, with no
 * statement (`schemaText.ts`). A model the schema does not answer for is
 * probed: one read of one row's id per model, kept for the life of the
 * client, which Prisma refuses for a model without an `id` column (a
 * composite `@@id`). Any other failure (the database down) is thrown, and
 * asked again next time.
 */
function createTrackability(
  delegate: (model: string) => Delegate,
  schema: PrismaSchemaFacts | undefined,
): (model: string) => Promise<boolean> {
  const known = new Map<string, Promise<boolean>>();
  const probe = async (key: string): Promise<boolean> => {
    try {
      const rows = await quietly(() => delegate(key).findMany({ select: { id: true }, take: 1 }));
      const [row] = Array.isArray(rows) ? (rows as Readonly<Record<string, unknown>>[]) : [];
      return row === undefined || idOf(row) !== undefined;
    } catch (error) {
      if (error instanceof Error && error.name === "PrismaClientValidationError") {
        return false;
      }
      throw error;
    }
  };
  return async (model) => {
    const declared = schema?.trackable(model);
    if (declared !== undefined) {
      return declared;
    }
    const key = modelKey(model);
    let answer = known.get(key);
    if (answer === undefined) {
      answer = probe(key);
      known.set(key, answer);
      answer.catch(() => {
        known.delete(key);
      });
    }
    return await answer;
  };
}

/**
 * The adapter the framework reads through. Its reads are the framework's own
 * (access checks, subscriptions, flushes, kits), so the development checks
 * of statements leave them alone.
 */
function createStorage(
  tracker: WriteTracker,
  [interest, links]: readonly [
    ReturnType<typeof createInterestRegistry>,
    ReturnType<typeof createLinkRegistry>,
  ],
  delegate: (model: string) => Delegate,
  schema: PrismaSchemaFacts | undefined,
): StorageAdapter {
  return Object.freeze({
    findMany: (model: string, args: FindManyArgs = {}) =>
      quietly(() => delegate(modelKey(model)).findMany(args as Args)),
    count: (model: string, args: CountArgs = {}) =>
      quietly(() => delegate(modelKey(model)).count(args as Args)),
    onWrite: tracker.onWrite,
    countStatements: tracker.countStatements,
    registerInterest: interest.register,
    interestOf: interest.of,
    registerLinks: links.register,
    linksOf: links.of,
    inTransaction: () => tracker.transactionClient() !== undefined || tracker.inBatch(),
    nullable: createNullability(delegate, schema),
    trackable: createTrackability(delegate, schema),
    unitOfWork: tracker.unitOfWork,
  });
}

/**
 * Wraps a Prisma client so the framework sees every write made through it:
 * `create`, `update`, `upsert`, `delete` and their `Many` forms, inside and
 * outside transactions. Pass the result as `db` to `initQuickdraw`'s app and
 * to `createServer`, which find its storage adapter on it (`storageOf`).
 * Nested writes, raw SQL and database cascades are not seen; record those
 * with `ctx.touch`.
 *
 * The result is a `Tracked<C>` (`tracked.ts`): still a `C`, but the
 * untracked client is no `Tracked<C>`, so a helper that writes takes
 * `db: Tracked<Db>` (or `TrackedTransaction<Db>`, which a transaction's `tx`
 * is too) and the compiler refuses the untracked client there.
 *
 * Prefer interactive transactions (`db.$transaction(async (tx) => ...)`). One
 * nested in it (`tx.$transaction(async (inner) => ...)`, a savepoint) is
 * tracked the same way: its writes join the transaction around it when it
 * commits, and are dropped when it rolls back, whatever the transaction
 * around it does next. Work on `db` inside one runs outside it, as Prisma
 * runs it, and is tracked so: its writes (and those of a `db.$transaction`
 * begun there) are sent whether or not the transaction commits. An
 * array-form `db.$transaction([...])` has no transaction client, so the rows
 * a `deleteMany` or `updateMany` there reads first (and an `update`'s old
 * values) are read on the root client, outside the batch: rows the batch's
 * earlier statements created or changed may be missed, and their frames
 * with them. A development warning names the model and operation once.
 *
 * @example
 * export const db = trackPrisma(new PrismaClient({ adapter }));
 * export const qd = initQuickdraw<{ db: typeof db; principal: AppPrincipal }>();
 * const server = qd.createServer({ app, services, db, auth });
 */
export function trackPrisma<C extends PrismaClientLike>(
  client: C,
  options: TrackPrismaOptions = {},
): Tracked<C> {
  if (!isClient(client)) {
    throw new TypeError("trackPrisma: client must be a Prisma client");
  }
  if (storageOf(client) !== undefined) {
    throw new TypeError("trackPrisma: this client is tracked already; pass the untracked client");
  }
  const tracker = createWriteTracker({
    logger: options.logger ?? consoleLogger,
    development: options.development,
  });
  const interest = createInterestRegistry(options.interest);
  // The client with the root client's hook; its reads run outside transactions.
  let root: ExtendedClient | undefined;
  // The framework's own reads: through the open interactive transaction, else the root client.
  const delegate = (model: string): Delegate =>
    delegateOf(tracker.transactionClient() ?? root, model);
  const links = createLinkRegistry();
  const runtimes = createRuntimes(
    { tracker, interestOf: interest.of, linksOf: links.of, untracked: new Set() },
    () => root,
  );
  const hooked = client.$extends({
    name: "quickdraw-tracking",
    query: { $allOperations: createHook(runtimes.root) },
  });
  root = hooked;
  // Interactive transactions begin here, so their clients carry the transaction clients' hook.
  const transactional = client.$extends({
    name: "quickdraw-tracking-transactions",
    query: { $allOperations: createHook(runtimes.transaction) },
  });
  const tracked = hooked.$extends({
    name: "quickdraw-transactions",
    client: {
      $transaction: (arg: unknown, txOptions?: unknown) =>
        transaction(
          tracker,
          typeof arg === "function" ? transactional : hooked,
          arg,
          txOptions,
          false,
        ),
      [STORAGE_KEY]: createStorage(tracker, [interest, links], delegate, prismaSchemaOf(client)),
    },
  });
  // `Tracked<C>` is a type: the client carries no mark at run time.
  return tracked as unknown as Tracked<C>;
}
