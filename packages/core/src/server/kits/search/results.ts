// The page a search answers with (RFC 0003 section 12.2). As for the
// read/write kit's `list`, the items are the item projection's rows,
// stripped once, at the level the page was read at (`readerLevel`). A search
// kept to a scope also strips what the scope's collection strips, since its
// results are that collection's items: when nothing else is missing from
// them, they are exactly the items the collection's subscribers receive, and
// the page carries the revision it was read at (`rev`), so a client can keep
// them in the collection's cache.

import type { SearchPage } from "../../../contract/kits/searchSchemas";
import type { Projection } from "../../emit/projection";
import { readerLevel } from "../crud/access";
import { pageItem } from "../crud/list";
import type { Row } from "../crud/runtime";
import type { SearchRun } from "./context";
import { scopedCollection } from "./filters";

/** A page with no results. */
export function emptyPage(): SearchPage<never> {
  return { items: [], nextCursor: null };
}

/** The fields a page's items go without, and whether they are the scope collection's items. */
function strippingOf(
  run: SearchRun,
  projection: Projection,
): { readonly hidden: ReadonlySet<string>; readonly collectionItems: boolean } {
  const { call, context, level } = run;
  const reader = projection.tiers.hidden(readerLevel(call, context.form, level));
  const collection = scopedCollection(run);
  if (collection === undefined) {
    return { hidden: reader, collectionItems: false };
  }
  const own = collection.item.tiers.hidden(collection.access);
  const hidden = new Set([...own, ...reader]);
  return { hidden, collectionItems: hidden.size === own.size };
}

/** The page of `rows`, in that order. */
export function resultsPage(
  run: SearchRun,
  projection: Projection,
  rows: readonly Row[],
  nextCursor: string | null,
): SearchPage<unknown> {
  const { hidden, collectionItems } = strippingOf(run, projection);
  return {
    items: rows.map((row) => pageItem(projection, row, hidden)),
    nextCursor,
    ...(collectionItems ? { rev: run.rev } : {}),
  };
}
