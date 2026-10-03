// `trackPrisma` (RFC 0003 sections 5.2 and 5.4): wraps an app's Prisma
// client so every write made through it is recorded into the unit of work it
// runs in. In 4.1 only `BaseService.create/update/delete` were observed
// (`legacy-src/server/BaseService.ts:769-827`); a raw `prisma.task.update`
// was invisible, and every live update needed a hand-written emit.
//
// Two client extensions, both public Prisma API:
//
// 1. a `query` hook on every operation records writes (`operations.ts`) and
//    counts statements;
// 2. a `client` extension replaces `$transaction`, so writes inside a
//    transaction are buffered and join the unit of work only once it commits.
//    It calls the `$transaction` of the client from step 1, so the
//    transaction's client carries the hook. Transactions are found through
//    that wrapper and `AsyncLocalStorage`, never through Prisma internals.
//
// Make it the last extension applied: an extension added after it still
// runs outside transactions, but not on a transaction's client.

import { consoleLogger, type Logger } from "../contract/logger";
import {
  createInterestRegistry,
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
  runUntracked,
  Untrackable,
  WRITE_OPERATIONS,
  type Args,
  type Delegate,
  type Operation,
  type Runtime,
} from "./operations";

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

function createHook(runtime: Runtime) {
  return async function track({ model, operation, args, query }: QueryHookArgs): Promise<unknown> {
    const handler = model === undefined ? undefined : WRITE_OPERATIONS[operation];
    if (model === undefined || handler === undefined || runtime.untracked.has(modelKey(model))) {
      runtime.tracker.countStatement();
      return query(args);
    }
    if (!delegates(runtime, operation)) {
      runtime.tracker.countStatement();
    }
    const op: Operation = { runtime, model: modelKey(model), args: args ?? {}, query };
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

/** `$transaction`, in both forms, inside a transaction frame of the tracker. */
async function transaction(
  tracker: WriteTracker,
  hooked: ExtendedClient,
  arg: unknown,
  options: unknown,
): Promise<unknown> {
  const interactive = typeof arg === "function";
  const frame = tracker.openTransaction(interactive ? "interactive" : "batch");
  try {
    const result = interactive
      ? await hooked.$transaction((client: unknown) => {
          frame.setClient(client);
          return frame.run(() => (arg as (client: unknown) => unknown)(client));
        }, options)
      : await frame.run(() => hooked.$transaction(arg, options));
    frame.commit();
    return result;
  } catch (error) {
    frame.rollback();
    throw error;
  }
}

/**
 * `StorageAdapter.nullable`: Prisma validates a filter against the schema
 * before sending it, and refuses `{ column: null }` on a required column. The
 * answer is kept for the life of the client: one statement per optional
 * column, none for a required one.
 */
function createNullability(
  delegate: (model: string) => Delegate,
): (model: string, column: string) => Promise<boolean> {
  const known = new Map<string, boolean>();
  return async (model, column) => {
    const key = `${modelKey(model)}\u0000${column}`;
    const kept = known.get(key);
    if (kept !== undefined) {
      return kept;
    }
    let nullable = true;
    try {
      await delegate(modelKey(model)).count({ where: { [column]: null } });
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

function createStorage(
  tracker: WriteTracker,
  interest: ReturnType<typeof createInterestRegistry>,
  delegate: (model: string) => Delegate,
): StorageAdapter {
  return Object.freeze({
    findMany: async (model: string, args: FindManyArgs = {}) =>
      await delegate(modelKey(model)).findMany(args as Args),
    count: async (model: string, args: CountArgs = {}) =>
      await delegate(modelKey(model)).count(args as Args),
    onWrite: tracker.onWrite,
    countStatements: tracker.countStatements,
    registerInterest: interest.register,
    interestOf: interest.of,
    inTransaction: () => tracker.transactionClient() !== undefined || tracker.inBatch(),
    nullable: createNullability(delegate),
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
 * @example
 * export const db = trackPrisma(new PrismaClient({ adapter }));
 * export const qd = initQuickdraw<{ db: typeof db; principal: AppPrincipal }>();
 * const server = qd.createServer({ app, services, db, auth });
 */
export function trackPrisma<C extends PrismaClientLike>(
  client: C,
  options: TrackPrismaOptions = {},
): C {
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
  // The client with the hook; the hook's own reads use it outside transactions.
  let root: ExtendedClient | undefined;
  const delegate = (model: string): Delegate =>
    delegateOf(tracker.transactionClient() ?? root, model);
  const runtime: Runtime = { tracker, delegate, interestOf: interest.of, untracked: new Set() };
  const hooked = client.$extends({
    name: "quickdraw-tracking",
    query: { $allOperations: createHook(runtime) },
  });
  root = hooked;
  const tracked = hooked.$extends({
    name: "quickdraw-transactions",
    client: {
      $transaction: (arg: unknown, txOptions?: unknown) =>
        transaction(tracker, hooked, arg, txOptions),
      [STORAGE_KEY]: createStorage(tracker, interest, delegate),
    },
  });
  return tracked as unknown as C;
}
