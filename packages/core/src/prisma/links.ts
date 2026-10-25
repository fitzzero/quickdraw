// The junction links a tracked delete of a via entry model reads first (RFC
// 0003 sections 5.2 and 7.2; the 5.1 audit's COLL-3). A `via` collection
// registers its junction as its entries' links (`registerLinks`); a `delete`
// or `deleteMany` of an entry then reads the junction rows that link the
// rows it deletes, through the client the delete came from (its open
// transaction's, for a transaction client), and records them in each
// write's `links`, possibly none, so its flush tells only the scopes a
// deleted entry was linked to. A junction the client does not have, or a
// read that fails validation (a column it does not have), leaves the links
// unknown, and warns once: such a delete's collections are told as for a
// row nobody can place, and the model stays tracked.
//
// The links are read in a statement of their own just before the delete,
// as `deleteMany` reads its ids: under the database's default isolation
// (read committed), and always outside an interactive transaction, a link
// another unit commits in between is removed by the delete's cascade
// without being read, so the scope it put the entry in keeps the entry
// until that scope is read again.

import { quietly } from "../server/devWarnings";
import type { WriteRecord } from "../server/uow/types";
import type { Delegate, Row, Runtime } from "./operations";

/** Per entry id, per junction model: the junction rows linking it. */
export type Links = ReadonlyMap<string, Record<string, Row[]>>;

/** Per tracked client (its tracker, which both of its runtimes share): the warnings given. */
const UNREAD = new WeakMap<object, Set<string>>();

/** Says once per model and junction that a delete's links could not be read. */
function warnUnread(runtime: Runtime, model: string, junction: string): void {
  const warned = UNREAD.get(runtime.tracker) ?? new Set<string>();
  UNREAD.set(runtime.tracker, warned);
  const key = `${model}\u0000${junction}`;
  if (warned.has(key)) {
    return;
  }
  warned.add(key);
  runtime.tracker.logger.warn(
    `Reading the ${junction} rows that link a deleted ${model} failed, so its deletes tell every subscribed scope of its via lists, as for a row nobody can place`,
    { category: "quickdraw.writes", model, junction },
  );
}

/**
 * The junction rows that link each of `ids`, rows of `model` about to be
 * deleted: per id, per registered junction, possibly none. One statement
 * per junction. `undefined` when `model` has no links or `ids` is empty
 * (nothing is read), or when a read failed validation.
 */
export async function readLinks(
  runtime: Runtime,
  model: string,
  ids: readonly string[],
): Promise<Links | undefined> {
  const links = runtime.linksOf(model);
  if (links.length === 0 || ids.length === 0) {
    return undefined;
  }
  const byId = new Map(
    ids.map((id) => [id, Object.fromEntries(links.map((link) => [link.model, [] as Row[]]))]),
  );
  for (const link of links) {
    const select = Object.fromEntries(
      [link.entry, ...link.columns].map((column) => [column, true]),
    );
    let delegate: Delegate;
    try {
      delegate = runtime.delegate(link.model);
    } catch {
      // A junction model the client does not have.
      warnUnread(runtime, model, link.model);
      return undefined;
    }
    let rows: Row[];
    try {
      rows = await quietly(() =>
        delegate.findMany({ where: { [link.entry]: { in: [...ids] } }, select }),
      );
    } catch (error) {
      if (error instanceof Error && error.name === "PrismaClientValidationError") {
        warnUnread(runtime, model, link.model);
        return undefined;
      }
      throw error;
    }
    for (const row of rows) {
      const entry = row[link.entry];
      if (typeof entry === "string") {
        byId.get(entry)?.[link.model]?.push(row);
      }
    }
  }
  return byId;
}

/** `writes`, each with its row's links when they were read. */
export function withLinks(writes: readonly WriteRecord[], links: Links | undefined): WriteRecord[] {
  return writes.map((write) => {
    const own = links?.get(write.id);
    return own === undefined ? write : { ...write, links: own };
  });
}
