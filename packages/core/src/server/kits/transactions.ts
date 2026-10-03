// The interactive transactions the kits write in (RFC 0003 sections 5.1 and
// 12). A transaction's writes join the call's unit of work when it commits
// and are dropped when it rolls back; the framework's own reads inside it
// (access policies) go through its client.
//
// A kit change that reads rows and writes what it decided from them (a
// sharing change, a `reorder`) runs SERIALIZABLE: PostgreSQL's default
// isolation (READ COMMITTED) would let two changes that run at once both read
// the old state, and the second write undo the first. Under SERIALIZABLE the
// database fails one of them instead, which the kit answers `CONFLICT`, and
// the caller may try again.

import { QuickdrawError } from "../../protocol/errors";

/** How a kit's transaction runs. */
export interface KitTransaction {
  /** Who runs it, for the error when the client has no `$transaction`: "The sharing kit's changes". */
  readonly owner: string;
  /**
   * Run SERIALIZABLE, answering a transaction the database fails for a
   * concurrent one with `CONFLICT` and this message. Default isolation without it.
   */
  readonly conflict?: string;
  /** The transaction's time limit in milliseconds; the client's default (Prisma's is 5 s) without it. */
  readonly timeoutMs?: number;
}

/**
 * True for Prisma's report of a transaction the database failed for a
 * concurrent one: `P2034` when a statement fails (a concurrent update of the
 * row), and the driver adapter's own `TransactionWriteConflict` when the
 * commit does (PostgreSQL finds most serialization failures only then;
 * Prisma 7 passes that one through unmapped).
 */
function isWriteConflict(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "PrismaClientKnownRequestError") {
    return (error as Error & { readonly code?: unknown }).code === "P2034";
  }
  const kind: unknown = (error.cause as { readonly kind?: unknown } | undefined)?.kind;
  return error.name === "DriverAdapterError" && kind === "TransactionWriteConflict";
}

function optionsOf(how: KitTransaction): object | undefined {
  const options = {
    ...(how.conflict === undefined ? {} : { isolationLevel: "Serializable" }),
    ...(how.timeoutMs === undefined ? {} : { timeout: how.timeoutMs }),
  };
  return Object.keys(options).length === 0 ? undefined : Object.freeze(options);
}

/** Runs `fn` in an interactive transaction of the database client, as `how` says. */
export async function inKitTransaction<T>(
  db: unknown,
  fn: (tx: unknown) => Promise<T>,
  how: KitTransaction,
): Promise<T> {
  const client = db as { readonly $transaction?: unknown } | null;
  if (typeof client?.$transaction !== "function") {
    throw new QuickdrawError("INTERNAL", `${how.owner} need a database client with $transaction`);
  }
  const run = client.$transaction as (
    callback: (tx: unknown) => Promise<T>,
    options?: object,
  ) => Promise<T>;
  const options = optionsOf(how);
  try {
    return options === undefined ? await run.call(client, fn) : await run.call(client, fn, options);
  } catch (error) {
    if (how.conflict === undefined || !isWriteConflict(error)) {
      throw error;
    }
    const conflict = new QuickdrawError("CONFLICT", how.conflict);
    conflict.cause = error;
    throw conflict;
  }
}
