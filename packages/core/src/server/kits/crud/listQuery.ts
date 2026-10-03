// The order and the filter of a read/write kit `list` page (RFC 0003 section
// 12.1), from the caller's parsed input: only declared fields reach here
// (the contract's input schema refuses any other), and a filter is equality
// on plain values, so nothing the caller sends becomes a query operator.

import type { OrderBy } from "../../../contract/collections";
import type { ListQuery } from "../../../contract/kits/crudList";
import type { StorageWhere } from "../../storage";

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
