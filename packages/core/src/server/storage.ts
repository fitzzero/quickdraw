// The storage adapter (RFC 0003 section 5.4): the one structural interface
// the server reads the database through, and through which it learns of
// writes. `trackPrisma` (`./prisma`) is the Prisma implementation; a Drizzle
// adapter would be a second one. The framework never imports generated
// Prisma types: rows are plain records, and `where`, `select` and `orderBy`
// take Prisma's object shapes.

import type { StatementCount } from "./uow/unitOfWork";
import type { UnitOfWorkFactory, WriteRecord } from "./uow/types";

/** A row as the adapter returns it. */
export type StorageRow = Readonly<Record<string, unknown>>;

/** A filter, in Prisma's `where` shape: `{ projectId: "p1", status: { in: ["open"] } }`. */
export type StorageWhere = Readonly<Record<string, unknown>>;

/** What `findMany` reads. */
export interface FindManyArgs {
  readonly where?: StorageWhere;
  /** The columns (and relations) to read, in Prisma's `select` shape: `{ id: true, title: true }`. */
  readonly select?: Readonly<Record<string, unknown>>;
  /** Prisma's `orderBy`: `[{ ordinal: "asc" }, { id: "asc" }]`. */
  readonly orderBy?:
    | Readonly<Record<string, unknown>>
    | readonly Readonly<Record<string, unknown>>[];
  readonly take?: number;
}

/** What `count` counts. */
export interface CountArgs {
  readonly where?: StorageWhere;
}

/**
 * The database as the server sees it. Models are named as the client names
 * them (`"task"`). Reads made inside an open interactive transaction go
 * through that transaction, so they see its writes.
 */
export interface StorageAdapter {
  findMany(model: string, args?: FindManyArgs): Promise<StorageRow[]>;
  count(model: string, args?: CountArgs): Promise<number>;
  /**
   * Calls `listener` with every write the adapter records, once it is
   * durable: when it lands in a unit of work, or flushes on its own. Writes
   * inside a transaction arrive when it commits; a rolled-back write never
   * arrives. Returns a function that removes the listener.
   */
  onWrite(listener: (write: WriteRecord) => void): () => void;
  /** Runs `fn` and counts the database statements it issued, the adapter's own reads included. */
  countStatements<T>(fn: () => T | PromiseLike<T>): Promise<StatementCount<T>>;
  /**
   * Declares the columns of `model` whose values the framework needs around
   * a write (scope, membership and owner columns). An update or `updateMany`
   * whose `data` sets one reads its old value first; every write reports
   * their values in `before` and `after`.
   */
  registerInterest(model: string, columns: readonly string[]): void;
  /** The columns registered for `model`. */
  interestOf(model: string): readonly string[];
  /** The units of work that record this adapter's writes; the dispatcher uses them. */
  readonly unitOfWork: UnitOfWorkFactory;
}

/** The property a tracked database client carries its storage adapter under. */
export const STORAGE_KEY = "$quickdrawStorage";

function isStorageAdapter(value: unknown): value is StorageAdapter {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof StorageAdapter, unknown>>;
  return (
    typeof candidate.findMany === "function" &&
    typeof candidate.count === "function" &&
    typeof candidate.countStatements === "function" &&
    typeof candidate.unitOfWork === "object" &&
    candidate.unitOfWork !== null
  );
}

/**
 * The storage adapter of a tracked database client (`trackPrisma(prisma)`),
 * or `undefined` for any other value. A client extended again after
 * `trackPrisma` still carries it.
 */
export function storageOf(db: unknown): StorageAdapter | undefined {
  if ((typeof db !== "object" && typeof db !== "function") || db === null) {
    return undefined;
  }
  const storage: unknown = Reflect.get(db, STORAGE_KEY);
  return isStorageAdapter(storage) ? storage : undefined;
}

/** Normalizes a model name to the client's spelling: `"TaskLabel"` and `"taskLabel"` are both `"taskLabel"`. */
export function modelKey(model: string): string {
  return model.length === 0 ? model : `${model.charAt(0).toLowerCase()}${model.slice(1)}`;
}

/** The columns registered per model, as `registerInterest` records them. */
export interface InterestRegistry {
  register(model: string, columns: readonly string[]): void;
  of(model: string): readonly string[];
}

/** An interest registry, seeded with `initial` (`{ task: ["projectId", "status"] }`). */
export function createInterestRegistry(
  initial: Readonly<Record<string, readonly string[]>> = {},
): InterestRegistry {
  const columns = new Map<string, readonly string[]>();
  const register = (model: string, added: readonly string[]): void => {
    if (typeof model !== "string" || model.length === 0) {
      throw new TypeError("registerInterest: model must be a model name");
    }
    if (!Array.isArray(added) || added.some((column) => typeof column !== "string")) {
      throw new TypeError(`registerInterest: the columns of ${model} must be an array of names`);
    }
    const key = modelKey(model);
    const merged = new Set([...(columns.get(key) ?? []), ...added]);
    merged.delete("id");
    columns.set(key, Object.freeze([...merged]));
  };
  for (const [model, added] of Object.entries(initial)) {
    register(model, added);
  }
  return Object.freeze({
    register,
    of: (model: string) => columns.get(modelKey(model)) ?? [],
  });
}
