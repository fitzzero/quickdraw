// The rows optimistic updates add (RFC 0003 section 11.4): `cache.addItem`
// and `cache.addEntity` in a mutation's `optimistic` update. The overlay
// store (`optimistic.ts`) keeps them with its layers, one per call and
// scope, and the collection hook shows them (`live/views.ts`).
//
// - An addition is a provisional item of one collection scope: the fields
//   the update gave, with its own id, or a provisional `qd:new:<n>` one.
//   It shows at once, flagged `pending` while its call is in flight; a
//   refused call drops it, unless it was added with `onRefused: "keep"`
//   (finding F6.4 of the quickdraw-chat migration): then it leaves the
//   items and stays as a refused one, with the call's error, until the app
//   dismisses it or sends the call again (`refused`, `dismiss`).
// - A call whose outcome is unknown (`isUnknownOutcome`: its connection
//   dropped after it was sent, or it timed out) refuses nothing yet: the
//   server may have made the write. Its additions stay, pending and flagged
//   `unknown`, until the scope's next load says: a load sent after the
//   failure that answers without the item refuses it (kept with
//   `onRefused: "keep"`, with the call's error), and one that holds it ends
//   it, its own copy shown instead (the final review of the release
//   candidates, item D). Only an id the client made and the server keeps
//   can be found: an item with a provisional id is refused by that load even
//   when the server made its row, under another id.
// - The reply names the server's id (`data.id`): the item takes it, and the
//   reply's values for the fields it has. A reply that names no id drops
//   it, as does one naming an id the scope already holds.
// - Once the scope accounts for it, it ends (`settle`): the scope's state
//   holds the id (its own copy shows instead, so the two never show
//   together), a delta named it, or a load of the scope sent after the
//   call's reply answered without it, so it is not a member. A refused or
//   unknown addition ends too once the scope holds its id, or a delta names
//   it: the server has that row. A finished addition nothing ends goes with
//   the store's expiry, as a layer does.
//
// React-free.

import type { QueryClient } from "@tanstack/react-query";
import type { CollectionDef } from "../contract/collections";
import type { QuickdrawError } from "../protocol/errors";
import { isRecord } from "../protocol/guards";
import { collectionKey } from "./keys";

/** A row as additions keep it: any object with a string `id`. */
export type AddedRow = Readonly<Record<string, unknown>> & { readonly id: string };

/** An item an optimistic update added to a scope (`OptimisticCache.addItem`). */
export interface AddedItem {
  /**
   * The item: the fields the update gave, with its own id (or a provisional
   * one) until the call's reply names the server's, whose values then
   * replace its own.
   */
  readonly item: AddedRow;
  /** True while the call is in flight, and while its outcome is unknown. */
  readonly pending: boolean;
  /**
   * True when the call's outcome is unknown (its connection dropped after it
   * was sent, or it timed out) until the scope's next load says.
   */
  readonly unknown: boolean;
}

/** What a refused call does with an item its update added (`cache.addItem(..., { onRefused })`). */
export type OnRefused = "drop" | "keep";

/** Options of `cache.addItem` and `cache.addEntity`. */
export interface AddItemOptions {
  /**
   * `"keep"`: when the server refuses the call, the item leaves the scope's
   * items and stays in `useCollection().refused` with the error, until the
   * app dismisses it or sends the call again (a chat's failed message, with
   * "retry"). Default `"drop"`: it goes with the refusal.
   */
  readonly onRefused?: OnRefused;
}

/** An added item whose call was refused, kept by `onRefused: "keep"` (`Additions.refused`). */
export interface RefusedAddition {
  readonly item: AddedRow;
  /** Why the call was refused. */
  readonly error: QuickdrawError;
  /** The addition itself, for `dismiss` and to send the call again. */
  readonly addition: Addition;
}

/** What a refused call left on a kept addition: its error, and how to send the call again. */
export interface Refusal {
  readonly error: QuickdrawError;
  /** Sends the same call again (the update runs again and adds its items anew). */
  readonly retry: () => Promise<unknown>;
}

/** A scope of a collection of a service. */
export interface ScopeRef {
  readonly service: string;
  readonly collection: string;
  readonly scope: string;
}

/** A call whose outcome is unknown: how its additions are refused if their scope's next load answers without them. */
interface Unknown {
  readonly refusal: Refusal;
  /** The store's clock when the call failed: a load sent at or after it is the evidence. */
  readonly at: number;
  /** True once its scope was asked for a load (`Additions.unchecked`). */
  asked: boolean;
}

/** What a scope's new state says about the finished additions to it (`settleAdditions`). */
export interface ScopeEvidence {
  /** True when the scope's state holds member `id`. */
  readonly holds: (id: string) => boolean;
  /** The ids the deltas just applied named. */
  readonly named?: ReadonlySet<string>;
  /** The overlay store's clock when the load just applied (a snapshot or a resume) was sent. */
  readonly readAt?: number;
}

/** One optimistic addition of one mutation call: a provisional item of one scope. */
export interface Addition {
  /** The scope's key: `scopeKey(service, collection, scope)`. */
  readonly key: string;
  readonly service: string;
  readonly collection: string;
  readonly scope: string;
  /** The item shown: the update's fields, with the server's id and values once the reply names them. */
  item: AddedRow;
  /** The store's clock when the call succeeded; absent while it is in flight. */
  finished: number | undefined;
  /** When a finished addition is dropped if nothing ended it before (`Date.now()` time). */
  expiresAt: number | undefined;
  /** Added with `onRefused: "keep"`: a refused call keeps it, as refused. */
  readonly keep: boolean;
  /** Set when its call was refused and it was kept: shown in `refused`, never in the items. */
  refusal: Refusal | undefined;
  /** Set while its call's outcome is unknown: shown in the items, pending, until its scope's next load says. */
  unknown: Unknown | undefined;
}

/** The additions of one overlay store. */
export interface Additions {
  /** How many it holds. */
  readonly size: number;
  /** Opens an addition of a call in flight to scope `scope` of `collection`; the oldest go past 1,000. */
  add(service: string, collection: string, scope: string, item: AddedRow, keep?: boolean): Addition;
  /**
   * The call of `additions` was refused: those added with `onRefused:
   * "keep"` stay, refused with `refusal`; returns the others, for the
   * caller to drop (`remove`).
   */
  refuse(additions: readonly Addition[], refusal: Refusal): Addition[];
  /**
   * The call of `additions` failed without an outcome (`isUnknownOutcome`)
   * at the store's clock `clock`: they stay, pending, until their scope's
   * next load says (`settle`), and are then refused with `refusal` if it
   * answers without them.
   */
  unknown(additions: readonly Addition[], refusal: Refusal, clock: number): void;
  /**
   * The scopes holding additions of unknown outcome that were not asked for
   * a load yet; marks them asked, so each is asked once.
   */
  unchecked(): ScopeRef[];
  /**
   * Finishes the additions of a call that succeeded with `data`, at the
   * store's clock `clock`, until `expiresAt`; returns those it dropped (the
   * reply names no id, or their scope holds it already).
   */
  finish(
    additions: readonly Addition[],
    data: unknown,
    clock: number,
    expiresAt: number,
  ): Addition[];
  /** Drops `additions`; returns those it held. */
  remove(additions: readonly Addition[]): Addition[];
  /**
   * Ends the additions to one scope that `evidence` accounts for, and
   * refuses those of unknown outcome that a load it reports answered without;
   * returns those it ended, and whether any was refused.
   */
  settle(
    service: string,
    collection: string,
    scope: string,
    evidence: ScopeEvidence,
  ): { readonly ended: Addition[]; readonly refused: boolean };
  /** The items added to a scope and shown in it, oldest first: not those refused. */
  added(service: string, collection: string, scope: string): readonly AddedItem[];
  /** The items added to a scope whose call was refused and that were kept, oldest first. */
  refused(service: string, collection: string, scope: string): readonly RefusedAddition[];
  /** Every addition, oldest scope first. */
  all(): Addition[];
  clear(): void;
}

/** The most additions a store keeps; past it the oldest go first. */
const MAX_ADDITIONS = 1000;

const NO_ADDITIONS: readonly AddedItem[] = Object.freeze([]);

const NO_REFUSALS: readonly RefusedAddition[] = Object.freeze([]);

function scopeKey(service: string, collection: string, scope: string): string {
  return `${service}\u0000${collection}\u0000${scope}`;
}

function isRow(value: unknown): value is AddedRow {
  return isRecord(value) && typeof value.id === "string";
}

/** The number in the next provisional id: `qd:new:1`, `qd:new:2`, ... */
let provisional = 0;

/** An id for an added item that names none: one no server id is (a colon, and the `qd:` prefix). */
function provisionalId(): string {
  provisional = provisional >= Number.MAX_SAFE_INTEGER ? 1 : provisional + 1;
  return `qd:new:${String(provisional)}`;
}

/** The item an update adds: a copy of its fields, with its own id or a provisional one. */
export function newItem(owner: string, item: unknown): AddedRow {
  if (!isRecord(item)) {
    throw new TypeError(`${owner}: the item must be an object of its fields`);
  }
  const { id } = item;
  if (id !== undefined && (typeof id !== "string" || id === "")) {
    throw new TypeError(`${owner}: an item's id must be a non-empty string, or left out`);
  }
  return Object.freeze({ ...item, id: id ?? provisionalId() }) as AddedRow;
}

/** The scope of each collection of entity rows that `row` belongs to, by its scope column and `where`. */
export function entityScopes(
  collections: Readonly<Record<string, CollectionDef>>,
  row: AddedRow,
): [collection: string, scope: string][] {
  return Object.entries(collections).flatMap(([name, def]): [string, string][] => {
    const scope = typeof def.scope === "string" ? row[def.scope] : undefined;
    const matches = Object.entries(def.where ?? {}).every(
      ([column, value]) => Object.hasOwn(row, column) && row[column] === value,
    );
    return def.item === "entity" && typeof scope === "string" && scope !== "" && matches
      ? [[name, scope]]
      : [];
  });
}

/** `item` with the server's id and the reply's values for the fields it has, when `data` is a row. */
function repliedItem(item: AddedRow, data: unknown): AddedRow | undefined {
  if (!isRow(data)) {
    return undefined;
  }
  const next: Record<string, unknown> = { ...item, id: data.id };
  for (const field of Object.keys(item)) {
    if (field !== "id" && Object.hasOwn(data, field)) {
      next[field] = data[field];
    }
  }
  return Object.freeze(next) as AddedRow;
}

/** True when the state the cache holds for the addition's scope holds member `id`. */
function scopeHolds(queryClient: QueryClient, addition: Addition, id: string): boolean {
  const entry = queryClient.getQueryData(
    collectionKey(addition.service, addition.collection, addition.scope),
  );
  const state: unknown = isRecord(entry) ? entry.state : undefined;
  if (!isRecord(state)) {
    return false;
  }
  const { revById, byId } = state;
  return (revById instanceof Map && revById.has(id)) || (byId instanceof Map && byId.has(id));
}

/** True when the scope holds the addition's id now, or a delta just named it: the server has that row. */
function found(addition: Addition, evidence: ScopeEvidence): boolean {
  const { id } = addition.item;
  return evidence.holds(id) || evidence.named?.has(id) === true;
}

/** True when `evidence` accounts for a finished addition: its scope holds it, or says it is not a member. */
function accounted(addition: Addition, evidence: ScopeEvidence): boolean {
  const { finished } = addition;
  const { readAt } = evidence;
  return (
    finished !== undefined &&
    (found(addition, evidence) || (readAt !== undefined && readAt >= finished))
  );
}

/** What `evidence` does to one addition: ends it, refuses it (an unknown outcome a later load answered without), or neither. */
function verdict(addition: Addition, evidence: ScopeEvidence): "end" | "refuse" | undefined {
  const { unknown, refusal } = addition;
  if (unknown === undefined && refusal === undefined) {
    return accounted(addition, evidence) ? "end" : undefined;
  }
  if (found(addition, evidence)) {
    return "end";
  }
  const { readAt } = evidence;
  if (unknown !== undefined && readAt !== undefined && readAt >= unknown.at) {
    return addition.keep ? "refuse" : "end";
  }
  return undefined;
}

/** Keeps the additions made with `onRefused: "keep"` as refused with `refusal`; returns the others. */
function refuseAdditions(additions: readonly Addition[], refusal: Refusal): Addition[] {
  const dropped: Addition[] = [];
  for (const addition of additions) {
    if (addition.keep) {
      addition.refusal = refusal;
    } else {
      dropped.push(addition);
    }
  }
  return dropped;
}

/** The items a scope's additions show: those not refused, flagged pending while their call is in flight. */
function shownOf(held: readonly Addition[] | undefined): readonly AddedItem[] {
  const shown = held?.filter((addition) => addition.refusal === undefined) ?? [];
  return shown.length === 0
    ? NO_ADDITIONS
    : shown.map((addition) => ({
        item: addition.item,
        pending: addition.finished === undefined,
        unknown: addition.unknown !== undefined,
      }));
}

/** A scope's refused additions, with their errors. */
function refusedOf(held: readonly Addition[] | undefined): readonly RefusedAddition[] {
  const refused = (held ?? []).flatMap((addition): RefusedAddition[] =>
    addition.refusal === undefined
      ? []
      : [{ item: addition.item, error: addition.refusal.error, addition }],
  );
  return refused.length === 0 ? NO_REFUSALS : refused;
}

/** A new addition of a call in flight. */
function newAddition(
  service: string,
  collection: string,
  scope: string,
  item: AddedRow,
  keep: boolean,
): Addition {
  return {
    key: scopeKey(service, collection, scope),
    service,
    collection,
    scope,
    item,
    finished: undefined,
    expiresAt: undefined,
    keep,
    refusal: undefined,
    unknown: undefined,
  };
}

/** The scopes of `additions` of unknown outcome not asked for a load yet; marks them asked. */
function unasked(additions: readonly Addition[]): ScopeRef[] {
  const scopes = new Map<string, ScopeRef>();
  for (const addition of additions) {
    if (addition.unknown !== undefined && !addition.unknown.asked) {
      addition.unknown.asked = true;
      const { service, collection, scope } = addition;
      scopes.set(addition.key, { service, collection, scope });
    }
  }
  return [...scopes.values()];
}

/** Applies `evidence` to one scope's additions: returns those it ends, and whether it refused any. */
function weigh(
  held: readonly Addition[],
  evidence: ScopeEvidence,
): { readonly ending: Addition[]; readonly refused: boolean } {
  const ending: Addition[] = [];
  let refused = false;
  for (const addition of held) {
    const outcome = verdict(addition, evidence);
    if (outcome === "end") {
      ending.push(addition);
    } else if (outcome === "refuse" && addition.unknown !== undefined) {
      addition.refusal = addition.unknown.refusal;
      addition.unknown = undefined;
      refused = true;
    }
  }
  return { ending, refused };
}

/** Creates the additions of the overlay store of `queryClient`, whose collection states it reads. */
export function createAdditions(queryClient: QueryClient): Additions {
  const byScope = new Map<string, Addition[]>();
  let size = 0;
  /** Set when a call's outcome turned unknown: some scope may need asking (`unchecked`). */
  let toCheck = false;
  const all = (): Addition[] => [...byScope.values()].flat();
  const removeOne = (addition: Addition): boolean => {
    const held = byScope.get(addition.key);
    const index = held?.indexOf(addition) ?? -1;
    if (held === undefined || index < 0) {
      return false;
    }
    held.splice(index, 1);
    if (held.length === 0) {
      byScope.delete(addition.key);
    }
    size -= 1;
    return true;
  };
  const remove = (additions: readonly Addition[]): Addition[] => additions.filter(removeOne);
  return {
    get size() {
      return size;
    },
    add(service, collection, scope, item, keep = false) {
      const addition = newAddition(service, collection, scope, item, keep);
      byScope.set(addition.key, [...(byScope.get(addition.key) ?? []), addition]);
      size += 1;
      // One at a time, so at most one past the limit.
      const oldest = size > MAX_ADDITIONS ? all()[0] : undefined;
      if (oldest !== undefined) {
        removeOne(oldest);
      }
      return addition;
    },
    finish(additions, data, clock, expiresAt) {
      const ended: Addition[] = [];
      for (const addition of additions) {
        const replied = repliedItem(addition.item, data);
        if (replied === undefined || scopeHolds(queryClient, addition, replied.id)) {
          ended.push(addition);
        } else {
          addition.item = replied;
          addition.finished = clock;
          addition.expiresAt = expiresAt;
        }
      }
      return remove(ended);
    },
    remove,
    refuse: refuseAdditions,
    unknown(additions, refusal, clock) {
      for (const addition of additions) {
        addition.unknown = { refusal, at: clock, asked: false };
        toCheck = true;
      }
    },
    unchecked() {
      const scopes = toCheck ? unasked(all()) : [];
      toCheck = false;
      return scopes;
    },
    settle(service, collection, scope, evidence) {
      const { ending, refused } = weigh(
        byScope.get(scopeKey(service, collection, scope)) ?? [],
        evidence,
      );
      return { ended: remove(ending), refused };
    },
    added: (service, collection, scope) =>
      shownOf(byScope.get(scopeKey(service, collection, scope))),
    refused: (service, collection, scope) =>
      refusedOf(byScope.get(scopeKey(service, collection, scope))),
    all,
    clear() {
      byScope.clear();
      size = 0;
    },
  };
}
