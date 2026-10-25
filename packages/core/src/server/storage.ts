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
   * durable, and returns a function that removes the listener. The access
   * cache (`cacheMs`) evicts from here, and a check later in the writing
   * call relies on this timing, which an adapter keeps:
   *
   * - Synchronously, before the write's promise settles for its caller: a
   *   write's own `await`, or for a transaction's writes its `$transaction`.
   * - Only for durable writes: one made outside every transaction at once
   *   (when it lands in a unit of work, or flushes on its own), a
   *   transaction's when it commits, a savepoint's when the outermost
   *   transaction around it commits, and a rolled-back write never.
   * - A listener that throws is logged; the write still lands and the other
   *   listeners are still called.
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
  /**
   * Declares that rows of `model` are the entries of a `via` collection over
   * the junction `link` names: a `delete` or `deleteMany` of `model` reads
   * the junction rows linking the rows it deletes just before, through the
   * open transaction when there is one, and reports them in each write's
   * `links`, so a flush tells only the scopes a deleted entry was linked to
   * (the 5.1 audit's COLL-3). A link committed between that read and the
   * delete is not read (`prisma/links.ts`). Optional: without it a deleted
   * entry left scopes nobody can name, and every subscribed scope of its
   * collection is told it was removed.
   */
  registerLinks?(model: string, link: LinkInterest): void;
  /** The junctions registered for `model` (`registerLinks`). */
  linksOf?(model: string): readonly LinkInterest[];
  /**
   * True where the caller runs inside an open transaction of this adapter,
   * whose reads see writes that may still roll back. The access cache
   * neither reads nor keeps anything there; an adapter without this method
   * gets no access cache across requests.
   */
  inTransaction?(): boolean;
  /**
   * Whether `column` of `model` may hold null. Collection cursors need it: a
   * keyset over a nullable column must place and compare nulls, and Prisma
   * refuses a null filter or null ordering on a required column. An adapter
   * without it has its order columns treated as never null, except one a
   * cursor shows holding null.
   */
  nullable?(model: string, column: string): Promise<boolean>;
  /**
   * Whether the adapter can key `model`'s writes: false for a model without
   * an `id` column (a table keyed by a composite `@@id`), whose writes are
   * never tracked. `createServer` asks it, at start, for every model an
   * access policy, a membership table or a `via` junction depends on, and
   * names each it cannot track (the `untracked-access-model` warning). An
   * adapter without it is not asked.
   */
  trackable?(model: string): Promise<boolean>;
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

/**
 * A junction whose rows link an entry model's rows to the scopes of a `via`
 * collection (`registerLinks`): its model, as the client names it, the
 * column holding the entry's id, and the columns a delete reads with it (the
 * scope column, and the role columns of a members table's rule).
 */
export interface LinkInterest {
  readonly model: string;
  readonly entry: string;
  readonly columns: readonly string[];
}

/** The junctions registered per entry model, as `registerLinks` records them. */
export interface LinkRegistry {
  register(model: string, link: LinkInterest): void;
  of(model: string): readonly LinkInterest[];
}

function isLink(value: unknown): value is LinkInterest {
  const link = (value ?? {}) as Partial<Record<keyof LinkInterest, unknown>>;
  return (
    typeof link.model === "string" &&
    link.model.length > 0 &&
    typeof link.entry === "string" &&
    link.entry.length > 0 &&
    Array.isArray(link.columns) &&
    link.columns.every((column) => typeof column === "string")
  );
}

/**
 * A link registry. Two registrations of one entry model over the same
 * junction and entry column (two `via` collections over one junction) are
 * one link, their columns merged, so a delete reads that junction once.
 */
export function createLinkRegistry(): LinkRegistry {
  const links = new Map<string, readonly LinkInterest[]>();
  const register = (model: string, link: LinkInterest): void => {
    if (typeof model !== "string" || model.length === 0) {
      throw new TypeError("registerLinks: model must be a model name");
    }
    if (!isLink(link)) {
      throw new TypeError(
        `registerLinks: the link of ${model} needs { model, entry, columns }: the junction model, its column holding the entry's id, and the columns to read`,
      );
    }
    const key = modelKey(model);
    const junction = modelKey(link.model);
    const known = links.get(key) ?? [];
    const same = known.find((other) => other.model === junction && other.entry === link.entry);
    const columns = Object.freeze([...new Set([...(same?.columns ?? []), ...link.columns])]);
    const merged = Object.freeze({ model: junction, entry: link.entry, columns });
    links.set(key, Object.freeze([...known.filter((other) => other !== same), merged]));
  };
  return Object.freeze({
    register,
    of: (model: string): readonly LinkInterest[] => links.get(modelKey(model)) ?? [],
  });
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
