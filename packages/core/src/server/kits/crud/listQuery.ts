// The order and the filter of a read/write kit `list` page (RFC 0003 section
// 12.1), from the caller's parsed input: only declared fields reach here
// (the contract's input schema refuses any other), and a filter is equality
// on plain values, so nothing the caller sends becomes a query operator.
//
// Nor may a call name a field the caller does not receive (a field tier,
// RFC 0003 section 6): whether a row passes an equality filter tells what
// the field holds, and a sort puts the field's values in the page's cursor
// and its order. Such a call is `FORBIDDEN`, and a default sort on such a
// field falls back to `id`. The admin kit's `adminList` follows the same
// rules.

import type { OrderBy } from "../../../contract/collections";
import type { ListQuery } from "../../../contract/kits/crudList";
import { QuickdrawError } from "../../../protocol/errors";
import type { StorageWhere } from "../../storage";

/** The fields a list call names: its filter's and its sort's. */
export function namedFields(query: Pick<ListQuery, "filter" | "sort">): string[] {
  return [...Object.keys(query.filter), ...(query.sort === undefined ? [] : [query.sort.field])];
}

/** `FORBIDDEN` when a call names one of the `hidden` fields of `service`: above the caller's level. */
export function checkVisible(
  service: string,
  hidden: ReadonlySet<string>,
  names: readonly string[],
): void {
  const unseen = names.find((name) => hidden.has(name));
  if (unseen !== undefined) {
    throw new QuickdrawError(
      "FORBIDDEN",
      `"${unseen}" is a field of ${service} above your access level`,
    );
  }
}

/** The declared sort fields a page may default to: none when the first is `hidden`, so the page sorts by `id`. */
export function defaultSorts(
  sortFields: readonly string[],
  hidden: ReadonlySet<string>,
): readonly string[] {
  const [first] = sortFields;
  return first !== undefined && hidden.has(first) ? [] : sortFields;
}

/** The order of a page: the caller's sort, else the first declared sort field, else `id`; `id` last. */
export function listOrder(sortFields: readonly string[], sort: ListQuery["sort"]): OrderBy {
  const field = sort?.field ?? sortFields[0];
  const direction = sort?.direction ?? "asc";
  if (field === undefined || field === "id") {
    return [["id", direction]];
  }
  return [
    [field, direction],
    ["id", direction],
  ];
}

/** The caller's equality filter and the access filter, together. */
export function listWhere(
  filter: ListQuery["filter"],
  access: StorageWhere | undefined,
): StorageWhere {
  const equal = Object.fromEntries(
    Object.entries(filter).filter(([, value]) => value !== undefined),
  );
  const parts = [equal, access ?? {}].filter((part) => Object.keys(part).length > 0);
  return parts.length > 1 ? { AND: parts } : (parts[0] ?? {});
}
