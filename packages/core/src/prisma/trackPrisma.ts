// `trackPrisma` (RFC 0003 sections 5.2 and 5.4): wraps an app's Prisma
// client so every write made through it is recorded into the unit of work it
// runs in. In 4.1 only `BaseService.create/update/delete` were observed
// (4.1 `src/server/BaseService.ts:769-827`); a raw `prisma.task.update`
// was invisible, and every live update needed a hand-written emit.
//
// Client extensions, all public Prisma API:
//
// 1. a `query` hook on every operation records writes (`operations.ts`) and
//    counts statements, over a runtime that says which client the operation
//    came from. The root client runs it over the root runtime
//    (`rootRuntime`), and each interactive transaction begins on a client of
//    its own, extended from the given one with the hook over that
//    transaction's runtime (`transactionRuntime`), which its savepoints'
//    clients carry too. Prisma itself carries which hook an operation runs,
//    through its lazy promises and batches alike, so no marker is set per
//    call and no Prisma internal is read. The root client's work runs
//    outside every interactive transaction, even inside one's callback, on a
//    connection of its own: its reads and writes go through the root
//    client, and its writes skip every open transaction frame, unless an
//    array-form batch runs them as its own. A transaction's client runs its
//    work in that transaction wherever it is used (another transaction's
//    callback, an array-form batch): its reads go through it and its writes
//    into its frame; once the transaction ended, the hook runs its work as
//    written, which Prisma refuses;
// 2. a `client` extension replaces `$transaction`, so writes inside a
//    transaction are buffered and join the unit of work only once it commits:
//    one begun on the root client commits on its own, wherever it is begun.
//    The transaction's client is handed to its callback behind a proxy whose
//    `$transaction` goes through the tracker too (`nestable`): on Prisma 7
//    the interactive form is a savepoint, whose writes join the transaction
//    around it only once the savepoint is released, and the array form a
//    transaction of its own, as Prisma runs it.
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
import {
  createWriteTracker,
  type TrackedTransaction as TransactionFrame,
  type WriteTracker,
} from "../server/uow/unitOfWork";
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

/** What every runtime of a tracked client shares. */
type SharedRuntime = Pick<Runtime, "tracker" | "interestOf" | "linksOf" | "untracked">;

/**
 * The runtime of the root client's operations. They run outside every
 * interactive transaction, even inside one's callback, on a connection of
 * their own: the hook's own queries go through the root client, and their
 * writes skip every open transaction frame, unless an array-form batch runs
 * them as its own (`WriteTracker.record`).
 */
function rootRuntime(shared: SharedRuntime, root: () => unknown): Runtime {
  const { tracker } = shared;
  return {
    ...shared,
    live: () => true,
    inBatch: () => tracker.inBatch(),
    delegate: (model) => delegateOf(root(), model),
    record: (writes) => {
      tracker.record(writes, "root");
    },
    observe: (statement) => {
      tracker.observe(statement, "root");
    },
  };
}

/**
 * The open frames of one transaction begun on the root client and of the
 * savepoints nested in it, innermost last: where that transaction's
 * clients' work goes, whichever frame is active where it runs.
 */
type Lineage = TransactionFrame[];

/**
 * The runtime of one transaction's clients, its own and its savepoints'
 * (`lineage`). Their operations run in that transaction, even inside
 * another transaction's callback or in an array-form batch: the hook's own
 * queries go through the innermost open savepoint's client, and their writes
 * into its frame. Once the transaction ended, `live` is false, and the hook
 * runs an operation as written, which Prisma refuses.
 */
function transactionRuntime(shared: SharedRuntime, lineage: Lineage): Runtime {
  const { tracker } = shared;
  return {
    ...shared,
    live: () => lineage.length > 0,
    // Its operations run in its transaction, never in an array-form batch holding them.
    inBatch: () => false,
    delegate: (model) => delegateOf(lineage.at(-1)?.client, model),
    record: (writes) => {
      lineage.at(-1)?.record(writes);
    },
    observe: (statement) => {
      tracker.observe(statement, "transaction");
    },
  };
}

function createHook(runtime: Runtime) {
  return async function track({ model, operation, args, query }: QueryHookArgs): Promise<unknown> {
    const handler = model === undefined ? undefined : WRITE_OPERATIONS[operation];
    if (
      model === undefined ||
      handler === undefined ||
      runtime.untracked.has(modelKey(model)) ||
      !runtime.live()
    ) {
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

/** What every transaction of a tracked client begins on. */
interface TransactionSettings {
  readonly tracker: WriteTracker;
  readonly shared: SharedRuntime;
  /** The client `trackPrisma` was given: each interactive transaction begins on its own extension of it. */
  readonly base: ExtendableClient;
  /** The client with the root client's hook: array-form transactions begin on it. */
  readonly hooked: ExtendedClient;
}

/** Takes `frame` off its lineage: the innermost frame, unless savepoints were begun side by side. */
function leave(lineage: Lineage, frame: TransactionFrame): void {
  const index = lineage.lastIndexOf(frame);
  if (index !== -1) {
    lineage.splice(index, 1);
  }
}

/** Awaits a transaction, then takes its frame off `lineage` and commits or rolls the frame back. */
async function settled(
  frame: TransactionFrame,
  lineage: Lineage,
  run: () => Promise<unknown>,
): Promise<unknown> {
  let result: unknown;
  try {
    result = await run();
  } catch (error) {
    leave(lineage, frame);
    frame.rollback();
    throw error;
  }
  leave(lineage, frame);
  frame.commit();
  return result;
}

/**
 * An array-form transaction, begun on `client`. Prisma runs it as a
 * transaction of its own, wherever it is begun, so its frame commits on its
 * own: the root client's operations in it are its own, while one made on a
 * transaction's client runs in that transaction all the same (the hook
 * awaits it there) and is recorded there.
 */
async function batch(
  tracker: WriteTracker,
  client: ExtendedClient,
  arg: unknown,
  options: unknown,
): Promise<unknown> {
  const frame = tracker.openTransaction("batch");
  return await settled(frame, [], () => frame.run(() => client.$transaction(arg, options)));
}

/**
 * An interactive transaction's client as its callback gets it: Prisma's own,
 * except that its `$transaction` goes through {@link nestedTransaction}, in
 * `lineage`. A client without `$transaction` is handed on as it is.
 */
function nestable(tracker: WriteTracker, client: unknown, lineage: Lineage): unknown {
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
        ? (arg: unknown, options?: unknown) =>
            nestedTransaction(tracker, own, lineage, arg, options)
        : Reflect.get(target, property);
    },
  });
}

/**
 * `tx.$transaction` on a transaction's client. The interactive form is a
 * savepoint of that transaction (Prisma 7), so its frame nests in the
 * innermost open one of `lineage`: its writes join that one's when it
 * commits, and are dropped when it rolls back; the client its callback gets
 * is wrapped the same way, so savepoints nest. The array form is a
 * transaction of its own ({@link batch}).
 */
async function nestedTransaction(
  tracker: WriteTracker,
  own: ExtendedClient,
  lineage: Lineage,
  arg: unknown,
  options: unknown,
): Promise<unknown> {
  if (typeof arg !== "function") {
    return await batch(tracker, own, arg, options);
  }
  const around = lineage.at(-1);
  if (around === undefined) {
    // The transaction ended: Prisma refuses this, as it would untracked.
    return await own.$transaction(arg, options);
  }
  const frame = around.nest();
  return await settled(frame, lineage, () =>
    own.$transaction((inner: unknown) => {
      frame.setClient(inner);
      lineage.push(frame);
      return frame.run(() =>
        (arg as (client: unknown) => unknown)(nestable(tracker, inner, lineage)),
      );
    }, options),
  );
}

/**
 * `db.$transaction`, in both forms: a transaction begun on the root client,
 * which commits on its own. The interactive form begins on a client of its
 * own, the hook over its lineage's runtime extending the client `trackPrisma`
 * was given, so the operations of its client and of its savepoints' are told
 * from every other transaction's, wherever they run (`transactionRuntime`).
 */
async function rootTransaction(
  settings: TransactionSettings,
  arg: unknown,
  options: unknown,
): Promise<unknown> {
  const { tracker } = settings;
  if (typeof arg !== "function") {
    return await batch(tracker, settings.hooked, arg, options);
  }
  const lineage: Lineage = [];
  const client = settings.base.$extends({
    name: "quickdraw-tracking-transaction",
    query: { $allOperations: createHook(transactionRuntime(settings.shared, lineage)) },
  });
  const frame = tracker.openTransaction("interactive");
  return await settled(frame, lineage, () =>
    client.$transaction((tx: unknown) => {
      frame.setClient(tx);
      lineage.push(frame);
      return frame.run(() => (arg as (client: unknown) => unknown)(nestable(tracker, tx, lineage)));
    }, options),
  );
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
 * begun there, either form) are sent whether or not the transaction
 * commits, while `tx`'s writes go to `tx`'s transaction wherever `tx` is
 * used. An array-form `db.$transaction([...])` has no transaction client,
 * so the rows a `deleteMany` or `updateMany` there reads first (and an
 * `update`'s old values) are read on the root client, outside the batch:
 * rows the batch's earlier statements created or changed may be missed,
 * and their frames with them. A development warning names the model and
 * operation once.
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
  const shared: SharedRuntime = {
    tracker,
    interestOf: interest.of,
    linksOf: links.of,
    untracked: new Set(),
  };
  const hooked = client.$extends({
    name: "quickdraw-tracking",
    query: { $allOperations: createHook(rootRuntime(shared, () => root)) },
  });
  root = hooked;
  const settings: TransactionSettings = { tracker, shared, base: client, hooked };
  const tracked = hooked.$extends({
    name: "quickdraw-transactions",
    client: {
      $transaction: (arg: unknown, txOptions?: unknown) =>
        rootTransaction(settings, arg, txOptions),
      [STORAGE_KEY]: createStorage(tracker, [interest, links], delegate, prismaSchemaOf(client)),
    },
  });
  // `Tracked<C>` is a type: the client carries no mark at run time.
  return tracked as unknown as Tracked<C>;
}
