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
// views at once, and an optimistic removal hides it. Items an optimistic
// update added (`OptimisticCache.addItem`) show in their place by the
// collection's `order`, through the view like any member, until the scope
// holds their id: then the scope's own copy shows, never both.
//
// Pure functions, React-free.

import type { CollectionDef, OrderBy, Viewer, ViewPredicate } from "../../contract/collections";
import {
  hasOrderValues,
  indexRowFromItem,
  insertionPoint,
  type CollectionShape,
  type IndexRow,
} from "./collectionIndex";
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
  /**
   * Items optimistic updates added to the scope, oldest first: each shows in
   * its place by `shape.order` (last when it, or an item shown without an
   * index, lacks an `order` field), unless the scope holds its id already.
   */
  readonly added?: readonly CollectionItem[];
  /** The collection's index fields and order, which place the added items. */
  readonly shape?: CollectionShape;
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

type Values = Readonly<Record<string, unknown>>;

/** Puts `added` among `items` by `order`, when it and every item hold the order's fields; else last. */
function placeAdded<T>(items: T[], added: readonly T[], order: OrderBy | undefined): void {
  const placeable =
    order !== undefined && items.every((item) => hasOrderValues(order, item as Values));
  for (const item of added) {
    const at =
      placeable && hasOrderValues(order, item as Values)
        ? insertionPoint(order, items as readonly Values[], item as Values)
        : items.length;
    items.splice(at, 0, item);
  }
}

/** The added items the state does not hold yet: once it holds one, its own copy shows. */
function notHeld<Item extends CollectionItem>(
  state: CollectionState<Item>,
  added: readonly CollectionItem[] | undefined,
): readonly Item[] {
  if (added === undefined || added.length === 0) {
    return [];
  }
  return added.filter((item) => !state.revById.has(item.id) && !state.byId.has(item.id)) as Item[];
}

/** What a hook shows of `state`: its members and items, overlaid and filtered by the view. */
export function showCollection<Item extends CollectionItem>(
  state: CollectionState<Item>,
  options: ShowOptions,
): CollectionView<Item> {
  const added = notHeld(state, options.added);
  const order = options.shape?.order;
  if (state.index === null) {
    const items = shown(
      loadedIds(state).map((id) => state.byId.get(id) as Item),
      options,
    );
    placeAdded(items, shown(added, options), order);
    return { items, index: undefined, byId: new Map(items.map((item) => [item.id, item])) };
  }
  const index = shown(state.index, options);
  const provisional = new Map<string, Item>();
  for (const item of added) {
    const overlaid = options.overlay(item);
    const row =
      overlaid === undefined ? undefined : indexRowFromItem(options.shape ?? {}, overlaid);
    if (row !== undefined && (options.view === undefined || options.view(row, options.who))) {
      index.splice(order === undefined ? index.length : insertionPoint(order, index, row), 0, row);
      provisional.set(row.id, overlaid as Item);
    }
  }
  const items: Item[] = [];
  for (const row of index) {
    const item = state.byId.get(row.id);
    const overlaid = item === undefined ? provisional.get(row.id) : options.overlay(item);
    if (overlaid !== undefined) {
      items.push(overlaid);
    }
  }
  return { items, index, byId: new Map(items.map((item) => [item.id, item])) };
}
