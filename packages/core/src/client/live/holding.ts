// What a script holds of its live store (RFC 0003 sections 7, 11.5 and
// 12.5): a row, a collection scope or a stream feed, read as the hooks show
// it (without the optimistic overlays, which never open on a live store),
// and told to a listener as it changes (`holdCollection.ts`,
// `holdEntity.ts`, `holdStream.ts`). A holding holds its row, scope or feed
// in the store until `release`, which lets go of it (the store
// unsubscribes a tick after its last holding ends) and calls the listener
// no more.
//
// The listener is called with each new snapshot, at most once a microtask,
// and first after `hold*` returns, with what the holding shows then
// (`isLoading` until the first answer): a listener that releases its
// holding, or reads the variable the holding was assigned to, finds it
// assigned. A snapshot is the same object while nothing it shows changed,
// and `current()` returns it too, the one shown at the release once released.
// While new credentials await their hello, a holding shows nothing of what
// is cached, as the hooks do: it may be the last user's.
//
// React-free, and TanStack-free.

import type { QuickdrawError } from "../../protocol/errors";
import { notifyEach } from "../watch";

/** A row, scope or feed a script holds (`holdCollection`, `holdEntity`, `holdStream`). */
export interface Holding<Snapshot> {
  /** What the holding shows now: the same object while nothing it shows changed. */
  current(): Snapshot;
  /**
   * Lets go of the row, scope or feed: the listener is called no more,
   * `current()` keeps returning what it showed then, and the store
   * unsubscribes it once nothing holds it. Calling it again does nothing.
   */
  release(): void;
}

/** What `holdCollection` shows of a scope: `useCollection`'s result, without the optimistic overlays. */
export interface CollectionSnapshot<Item, Row> {
  /** The items loaded among the members shown, in order. */
  readonly items: readonly Item[];
  /**
   * The members shown, in order: one row each, `id` and the index fields.
   * `undefined` for a collection without an index, and for a scope too large
   * for one (`indexTruncated`), whose view then runs over the items loaded.
   */
  readonly index: readonly Row[] | undefined;
  /** `items` by id. */
  readonly byId: ReadonlyMap<string, Item>;
  /** How many members the scope has, whatever the view; `null` before the first load. */
  readonly totalCount: number | null;
  /** True while a page follows the items loaded (`loadMore`). */
  readonly hasMore: boolean;
  /** True when the page size asked for was above the collection's `maxLimit`, and was lowered to it. */
  readonly clamped: boolean;
  /** True when the scope has more members than an index holds (50,000), so `index` is `undefined`. */
  readonly indexTruncated: boolean;
  /** True until the scope's first load answers. */
  readonly isLoading: boolean;
  /** True while a page is being loaded. */
  readonly isLoadingMore: boolean;
  /** Why the last request failed, or why the server ended the subscription (`FORBIDDEN`, `NOT_FOUND`). */
  readonly error: QuickdrawError | null;
}

/** A collection scope a script holds. */
export interface CollectionHolding<Item, Row> extends Holding<CollectionSnapshot<Item, Row>> {
  /** Loads the next page; a load of the whole scope that starts meanwhile cancels it. */
  loadMore(): Promise<void>;
  /** Loads the items of members `ids` (at most 200 per request). Rejects with the server's refusal. */
  loadItems(ids: readonly string[]): Promise<void>;
  /** Loads the scope again from scratch. */
  refresh(): Promise<void>;
}

/** What `holdEntity` shows of a row: `useEntity`'s result, without the optimistic overlays. */
export interface EntitySnapshot<Row> {
  /**
   * The row as the subscriber's access tier sees it (fields above that tier
   * are absent); `undefined` while loading, once removed, or after an error.
   */
  readonly data: Row | undefined;
  /** True until the first answer for the row. */
  readonly isLoading: boolean;
  /** True when the server says the row does not exist (deleted, or never there). */
  readonly isRemoved: boolean;
  /** Why the subscription failed or ended: `FORBIDDEN` when access is refused or revoked. */
  readonly error: QuickdrawError | null;
}

/** What `holdStream` shows of a feed: `useStream`'s result. */
export interface StreamSnapshot<Item> {
  /** The latest items, oldest first: the seed, then what was pushed after it. */
  readonly items: readonly Item[];
  /** True until the server answers the subscribe with the seed. */
  readonly isLoading: boolean;
  /** Why the subscribe was refused: `FORBIDDEN` for a feed the user may not read. */
  readonly error: QuickdrawError | null;
}

/**
 * A holding whose snapshot `read` gives, told by `listen` of each change
 * that may change it; `letGo` ends the store's hold of it. `listener` hears
 * each new snapshot, at most once a microtask, the first after this returns.
 */
export function holdingOf<Snapshot>(
  read: () => Snapshot,
  listen: (changed: () => void) => () => void,
  letGo: () => void,
  listener: (snapshot: Snapshot) => void,
): Holding<Snapshot> {
  let released = false;
  let queued = false;
  let told: { readonly snapshot: Snapshot } | undefined;
  const tell = (): void => {
    queued = false;
    if (released) {
      return;
    }
    const snapshot = read();
    if (told === undefined || told.snapshot !== snapshot) {
      told = { snapshot };
      notifyEach([listener], (each) => {
        each(snapshot);
      });
    }
  };
  const changed = (): void => {
    if (!queued && !released) {
      queued = true;
      queueMicrotask(tell);
    }
  };
  const stop = listen(changed);
  // The first call, once the caller holds the holding.
  changed();
  // What it showed at its release: the store forgets the row, scope or feed after.
  let final: { readonly snapshot: Snapshot } | undefined;
  return Object.freeze({
    current: (): Snapshot => (final === undefined ? read() : final.snapshot),
    release(): void {
      if (!released) {
        final = { snapshot: read() };
        released = true;
        stop();
        letGo();
      }
    },
  });
}
