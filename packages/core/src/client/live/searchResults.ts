// What `useSearch` sends and shows (RFC 0003 section 12.2), free of React.
//
// A method the search kit made gets `useSearch` on its member (`members.ts`)
// with what the contract says about it: how long a query must be, and the
// collection its results are items of, when it keeps to a collection's
// scopes and its item is that collection's item. A page the server marks
// with `rev` holds exactly the items that collection's subscribers receive:
// while a hook holds that scope (`useCollection`), the results are kept in
// its state (`CollectionHub.keep`) and shown as that state holds them, so the
// scope's deltas keep them current, and a result the state has removed since
// is left out. Otherwise a result shows as the page has it. Overlays of
// optimistic mutations are laid over every result, as over a collection's
// items.

import type { AnyContract } from "../../contract/defineContract";
import { searchSpecOf, type SearchSpec } from "../../contract/kits/search";
import type { SearchPage } from "../../contract/kits/searchSchemas";
import type { MethodDef } from "../../contract/methods";
import type { MethodTarget } from "../members";
import type { OverlayView } from "../optimistic";
import type { CollectionState } from "./collectionState";

/** A method the search kit made, as `useSearch` runs it. */
export interface SearchTarget extends MethodTarget {
  /** How long a query must be, once trimmed, to be sent. */
  readonly minLength: number;
  /** The collection whose items the results are, when they are: its scopes' states keep them live. */
  readonly collection: string | undefined;
}

/** What a call of a search passes: `{ q, scope?, limit? }`. */
export interface SearchCall {
  readonly q: string;
  readonly scope?: string;
  readonly limit?: number;
}

/** The projection a search's results are: `"entity"`, a projection's name, or `undefined` for none of the contract's. */
function itemName(contract: AnyContract, spec: SearchSpec): string | undefined {
  if (spec.item === undefined || spec.item === contract.entity) {
    return "entity";
  }
  return Object.entries(contract.projections).find(([, schema]) => schema === spec.item)?.[0];
}

/** The collection a search's results are items of: its scope collection, when its item is the search's. */
function liveCollection(contract: AnyContract, spec: SearchSpec): string | undefined {
  const { scope } = spec;
  if (scope === undefined || !Object.hasOwn(contract.collections, scope)) {
    return undefined;
  }
  return contract.collections[scope]?.item === itemName(contract, spec) ? scope : undefined;
}

/** The search `target` runs, when the search kit made its method; `undefined` for any other. */
export function searchTargetOf(
  target: MethodTarget,
  definition: MethodDef,
  contract: AnyContract,
): SearchTarget | undefined {
  const spec = searchSpecOf(definition);
  if (spec === undefined || target.kind !== "query") {
    return undefined;
  }
  return Object.freeze({
    ...target,
    minLength: spec.minLength,
    collection: liveCollection(contract, spec),
  });
}

/** The input of a search for `q`, in `scope` (none when empty), of `limit` results (the server's default when absent). */
export function searchCall(q: string, scope: string, limit: number | undefined): SearchCall {
  return {
    q,
    ...(scope === "" ? {} : { scope }),
    ...(limit === undefined ? {} : { limit }),
  };
}

const NO_RESULTS: readonly never[] = Object.freeze([]);

/** `item` as `state` holds it: its item there, `undefined` once `state` removed it, else `item` itself. */
function heldItem<Item>(item: Item, state: CollectionState | null): Item | undefined {
  const id = (item as { readonly id?: unknown }).id;
  if (state === null || typeof id !== "string") {
    return item;
  }
  const held = state.byId.get(id);
  if (held !== undefined) {
    return held as Item;
  }
  return state.removed.has(id) ? undefined : item;
}

/**
 * The results `page` shows, in its order: as `state` holds them when the
 * page's items are its collection's (`rev`) and `state` is the held scope's
 * state, else as the page has them; each with the overlays of `view`.
 * `collection` names the collection whose `patchItem` layers apply.
 */
export function shownResults<Item>(
  page: SearchPage<Item> | undefined,
  state: CollectionState | null,
  view: OverlayView,
  collection: string | undefined,
): readonly Item[] {
  if (page === undefined) {
    return NO_RESULTS;
  }
  const through = page.rev === undefined ? null : state;
  const options = through === null ? {} : { collection };
  const shown: Item[] = [];
  for (const item of page.items) {
    const row = heldItem(item, through);
    const overlaid = row === undefined ? undefined : view.apply(row, options);
    if (overlaid !== undefined) {
      shown.push(overlaid);
    }
  }
  return shown;
}
