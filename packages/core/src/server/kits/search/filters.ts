// The parts of a search (RFC 0003 section 12.2): the condition that matches
// the query, the scope's members, the order the results come in, and the
// ids a strategy ranked. The handler (`run.ts`) puts them together with the
// access filter.
//
// The default condition is a case-insensitive "contains" of the query in any
// of the declared fields. Prisma passes LIKE's wildcards in a `contains`
// value through to PostgreSQL, so `%`, `_` and the escape character `\` in
// the query are escaped: "50%" finds "50%", not "500". A field the caller's
// level would not receive (a field tier, RFC 0003 section 6) is not searched
// either, so whether a row matches never tells a caller what such a field
// holds.

import type { OrderBy } from "../../../contract/collections";
import { QuickdrawError } from "../../../protocol/errors";
import type { ServiceCollection } from "../../collections/define";
import { membersWhere } from "../../collections/snapshot";
import type { FindManyArgs, StorageWhere } from "../../storage";
import { readerLevel } from "../crud/access";
import { delegateOf, projectionOf, uniqueIds } from "../crud/runtime";
import type { SearchRun } from "./context";

/** The order of a search without a scope collection. */
const ID_ORDER: OrderBy = Object.freeze([["id", "asc"]]) as unknown as OrderBy;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `parts` together: `{}` for none, the one part, or their `AND`. */
export function allOf(parts: readonly (StorageWhere | undefined)[]): StorageWhere {
  const kept = parts.filter(
    (part): part is StorageWhere => part !== undefined && Object.keys(part).length > 0,
  );
  return kept.length > 1 ? { AND: kept } : (kept[0] ?? {});
}

/** `q` as a LIKE pattern's literal text: its wildcards and escape character escaped. */
export function likeLiteral(q: string): string {
  return q.replace(/[\\%_]/g, "\\$&");
}

/** The default condition: `q` in any of `fields`, ignoring case. */
export function containsWhere(fields: readonly string[], q: string): StorageWhere {
  const contains = likeLiteral(q);
  return { OR: fields.map((field) => ({ [field]: { contains, mode: "insensitive" } })) };
}

/** The declared fields the caller's level receives, which the default condition looks in. */
function searchedFields(run: SearchRun): readonly string[] {
  const { call, context, level } = run;
  const hidden = projectionOf(call, "entity").tiers.hidden(readerLevel(call, context.form, level));
  return context.spec.fields.filter((field) => !hidden.has(field));
}

/** The condition of the rows that match the query: the strategy's `where`, or the default; `"none"` when nothing can match. */
export async function textWhere(run: SearchRun): Promise<StorageWhere | "none"> {
  const where = run.context.strategy?.where;
  if (where === undefined) {
    const fields = searchedFields(run);
    return fields.length === 0 ? "none" : containsWhere(fields, run.query.q);
  }
  const filter: unknown = await where(run.query.q, run.ctx);
  if (!isRecord(filter)) {
    throw new QuickdrawError(
      "INTERNAL",
      `The search strategy of ${run.call.runtime.service.name} must return a filter object from where`,
    );
  }
  return filter;
}

/** The collection a call keeps to: the search's scope collection, when the call passed a scope. */
export function scopedCollection(run: SearchRun): ServiceCollection | undefined {
  const { scope } = run.context.spec;
  if (scope === undefined || run.query.scope === undefined) {
    return undefined;
  }
  const collection = run.call.runtime.service.collections.get(scope);
  if (collection === undefined) {
    throw new QuickdrawError(
      "INTERNAL",
      `The search kit asked ${run.call.runtime.service.name} for collection "${scope}", which it does not have`,
    );
  }
  return collection;
}

/**
 * The members of the call's scope: its column and `where`, or the ids its
 * `via` junction links to it (one read, through the database client).
 * `undefined` without a scope; `"none"` for a scope without members.
 */
export async function scopeWhere(run: SearchRun): Promise<StorageWhere | "none" | undefined> {
  const collection = scopedCollection(run);
  if (collection === undefined || run.query.scope === undefined) {
    return undefined;
  }
  const reader = {
    findMany: (model: string, args?: FindManyArgs) =>
      delegateOf(run.db, model).findMany(args ?? {}),
  };
  return (await membersWhere(reader, collection, run.query.scope)) ?? "none";
}

/** The order results come in: the scope collection's, else by id. No ranking. */
export function searchOrder(run: SearchRun): OrderBy {
  const { scope } = run.context.spec;
  const collection =
    scope === undefined ? undefined : run.call.runtime.service.collections.get(scope);
  return collection?.order ?? ID_ORDER;
}

/** The ids a strategy ranked, each once and at most `limit`, or `INTERNAL` for anything else. */
export function rankedIds(run: SearchRun, ids: unknown): string[] {
  const valid = Array.isArray(ids) && ids.every((id) => typeof id === "string" && id.length > 0);
  if (!valid) {
    throw new QuickdrawError(
      "INTERNAL",
      `The search strategy of ${run.call.runtime.service.name} must return a list of row ids from ids`,
    );
  }
  return uniqueIds(ids as string[]).slice(0, run.query.limit);
}
