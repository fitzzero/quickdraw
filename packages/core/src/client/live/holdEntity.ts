// `holdEntity(store, target, listener)` (RFC 0003 sections 6 and 11.5): one
// row of a contract's entity, held in a script's live store
// (`liveStore.ts`) and shown as `useEntity` shows it, with no optimistic
// overlays: loaded with `qd:sub`, kept current by the server's frames,
// resumed by revision after a reconnect. See `holding.ts` for when the
// listener is called.
//
// React-free, and TanStack-free.

import type { AnyContract, RowSchema } from "../../contract/defineContract";
import type { EntityOf } from "../../contract/infer";
import { awaitingHelloOf } from "../cacheSession";
import { entityKey } from "../keys";
import { EMPTY_ENTITY, type EntityEntry } from "./entities";
import { holdingOf, type EntitySnapshot, type Holding } from "./holding";
import { liveCacheOf, type LiveStore } from "./liveStore";

/** A contract that declares an entity: what `holdEntity` takes. */
export type EntityContract = AnyContract & { readonly entity: RowSchema };

/** What `holdEntity` holds: one row of a contract's entity. */
export interface HoldEntityTarget<C extends EntityContract> {
  readonly contract: C;
  /** The row's id: a non-empty string. */
  readonly id: string;
}

function snapshotOf(entry: EntityEntry | undefined): EntitySnapshot<unknown> {
  const held = entry ?? EMPTY_ENTITY;
  return Object.freeze({
    data: held.data,
    isLoading: held.data === undefined && !held.removed && held.error === null,
    isRemoved: held.removed,
    error: held.error,
  });
}

/**
 * Holds row `target.id` of `target.contract`'s entity in `store`, and calls
 * `listener` with what it shows as that changes. Throws a `TypeError` for a
 * contract with no entity, or an id that is not a non-empty string.
 *
 * @example
 * const row = holdEntity(live, { contract: task, id }, (task) => {
 *   if (task.data?.status === "done") row.release();
 * });
 */
export function holdEntity<C extends EntityContract>(
  store: LiveStore,
  target: HoldEntityTarget<C>,
  listener: (snapshot: EntitySnapshot<EntityOf<C>>) => void,
): Holding<EntitySnapshot<EntityOf<C>>> {
  const { contract } = target;
  const id: unknown = target.id;
  // Typed out, but a contract cast to it, or plain JavaScript, may still have none.
  if ((contract as AnyContract).entity === undefined) {
    throw new TypeError(`holdEntity: ${contract.name} declares no entity`);
  }
  if (typeof id !== "string" || id === "") {
    throw new TypeError("holdEntity: id must be a non-empty string");
  }
  const cache = liveCacheOf(store);
  const { connection } = store;
  const key = entityKey(contract.name, id);
  let last:
    | { readonly entry: EntityEntry | undefined; readonly snapshot: EntitySnapshot<unknown> }
    | undefined;
  const read = (): EntitySnapshot<unknown> => {
    // Awaiting new credentials' hello, it shows nothing of what is cached.
    const entry = awaitingHelloOf(connection, cache)
      ? undefined
      : (cache.get(key) as EntityEntry | undefined);
    if (last !== undefined && last.entry === entry) {
      return last.snapshot;
    }
    const snapshot = snapshotOf(entry);
    last = { entry, snapshot };
    return snapshot;
  };
  const release = store.entities.subscribe(contract.name, [id]);
  return holdingOf(
    { connection, read, listen: (changed) => cache.listen(key, changed), letGo: release },
    listener as (snapshot: EntitySnapshot<unknown>) => void,
  ) as Holding<EntitySnapshot<EntityOf<C>>>;
}
