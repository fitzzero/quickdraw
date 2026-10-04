// What `useCollection` shows of a scope's state (RFC 0003 sections 7.5 and
// 11.4): the members a view selects, the items loaded among them in order,
// with the overlays of optimistic mutations laid over both.
//
// A view is a named pure predicate of the contract, `(row, who) => boolean`,
// run on the client over index rows, with `who` the connection's user from
// `qd:hello`. The whole index is present and live, so a view needs no
// filter on the server, and an item enters or leaves a view as soon as a
// delta changes its index fields. A scope too large for an index
// (`indexTruncated`) has none: its view runs over the items loaded, which
// carry the index fields too.
//
// Overlays apply to index rows as to items (only fields a row has are laid
// over it), so an optimistic edit of an index field moves the member between
// views at once, and an optimistic removal hides it.
//
// Pure functions, React-free.

import type { CollectionDef, Viewer, ViewPredicate } from "../../contract/collections";
import type { IndexRow } from "./collectionIndex";
import { loadedIds, type CollectionItem, type CollectionState } from "./collectionStore";

/** A view's predicate, as the client runs it. */
export type RowPredicate = (row: Readonly<Record<string, unknown>>, who: Viewer) => boolean;

/** A view the collection does not declare selects nothing, rather than everything. */
const NO_MEMBERS: RowPredicate = () => false;

/**
 * The predicate of view `name` of a collection: `undefined` for no view, and
 * one that selects nothing for a name the collection does not declare (the
 * client's types refuse such a name; a caller without them gets no rows).
 */
export function viewPredicate(
  def: Pick<CollectionDef, "views">,
  name: string | undefined,
): RowPredicate | undefined {
  if (name === undefined) {
    return undefined;
  }
  if (def.views === undefined || !Object.hasOwn(def.views, name)) {
    return NO_MEMBERS;
  }
  return def.views[name] as ViewPredicate<unknown> as RowPredicate;
}

/** Lays the overlays over a row, or hides it: `undefined`. */
export type Overlay = <T>(row: T) => T | undefined;

/** How {@link showCollection} filters and overlays. */
export interface ShowOptions {
  readonly view?: RowPredicate | undefined;
  readonly who: Viewer;
  readonly overlay: Overlay;
}

/** What a hook shows of a scope. */
export interface CollectionView<Item> {
  /** The items loaded among the members shown, in order. */
  readonly items: readonly Item[];
  /** The members shown, in order; `undefined` without an index. */
  readonly index: readonly IndexRow[] | undefined;
  /** `items` by id. */
  readonly byId: ReadonlyMap<string, Item>;
}

/** `rows` overlaid, without the hidden ones and, with a view, without those it does not select. */
function shown<T>(rows: Iterable<T>, options: ShowOptions): T[] {
  const kept: T[] = [];
  for (const row of rows) {
    const overlaid = options.overlay(row);
    const selected =
      overlaid !== undefined &&
      (options.view === undefined ||
        options.view(overlaid as Readonly<Record<string, unknown>>, options.who));
    if (selected) {
      kept.push(overlaid);
    }
  }
  return kept;
}

/** What a hook shows of `state`: its members and items, overlaid and filtered by the view. */
export function showCollection<Item extends CollectionItem>(
  state: CollectionState<Item>,
  options: ShowOptions,
): CollectionView<Item> {
  if (state.index === null) {
    const items = shown(
      loadedIds(state).map((id) => state.byId.get(id) as Item),
      options,
    );
    return { items, index: undefined, byId: new Map(items.map((item) => [item.id, item])) };
  }
  const index = shown(state.index, options);
  const items: Item[] = [];
  for (const row of index) {
    const item = state.byId.get(row.id);
    const overlaid = item === undefined ? undefined : options.overlay(item);
    if (overlaid !== undefined) {
      items.push(overlaid);
    }
  }
  return { items, index, byId: new Map(items.map((item) => [item.id, item])) };
}
