// The collections of a dispatcher's services, bound to what serves them
// (RFC 0003 sections 5.1 and 7.1): each anchor resolved to the served service
// whose policy authorizes its scopes, and the columns that decide membership
// registered with the storage adapter, so a write reports their values
// (`before` and `after`) and a write that sets one reads the old value first.
// Those are the scope column, the `where` columns, and a `via` junction's
// entry and scope columns: every other write cannot move a row between
// scopes, and costs no extra read. Order columns are not registered: no
// collection change depends on their old values.

import type { Hub } from "../emit/hub";
import type { Registry } from "../registry";
import type { AnyService } from "../service";
import { modelKey, type StorageAdapter } from "../storage";
import { createDeltaBuffer, type DeltaBuffer } from "./buffer";
import type { ServiceCollection } from "./define";
import { ScopeIndex } from "./scopes";

/** A collection of a served service, with its anchor's service. */
export interface BoundCollection extends ServiceCollection {
  /** The service the collection is a member of. */
  readonly service: AnyService;
  /** The service's model, as the client names it. */
  readonly model: string;
  /** The service whose policy authorizes the scopes; `undefined` for a `"self"` scope. */
  readonly anchorService: AnyService | undefined;
}

/** How writes find collections. */
export interface CollectionRoutes {
  /** The collections whose items are rows of each model. */
  readonly byModel: ReadonlyMap<string, readonly BoundCollection[]>;
  /** The `via` collections whose junction is each model. */
  readonly byJunction: ReadonlyMap<string, readonly BoundCollection[]>;
  /** The collections anchored on a service of each model: deleting such a row closes their scopes. */
  readonly byAnchorModel: ReadonlyMap<string, readonly BoundCollection[]>;
  /** The collection `name` of service `service`. */
  find(service: string, name: string): BoundCollection | undefined;
}

/** What a dispatcher keeps for its collections. */
export interface CollectionState {
  readonly routes: CollectionRoutes;
  readonly scopes: ScopeIndex;
  readonly buffer: DeltaBuffer;
}

/** A dispatcher's live data with its collections: the same hub object, so the server it attaches is shared. */
export interface CollectionHub extends Hub {
  readonly collections: CollectionState;
}

function fail(message: string): never {
  throw new TypeError(`createDispatcher: ${message}`);
}

function anchorOf(
  registry: Registry,
  service: AnyService,
  collection: ServiceCollection,
): AnyService | undefined {
  const { anchor } = collection;
  if (anchor === undefined) {
    return undefined;
  }
  const owner = `${service.name}.${collection.name}`;
  const target = registry.services.get(anchor.name);
  if (target === undefined) {
    fail(`${owner} is anchored on ${anchor.name}, which this dispatcher does not serve`);
  }
  if (target.model === undefined || target.access === undefined) {
    fail(
      `${owner} is anchored on ${target.name}, which declares no model and access policy to authorize its scopes with`,
    );
  }
  return target;
}

function add(
  index: Map<string, BoundCollection[]>,
  model: string,
  collection: BoundCollection,
): void {
  index.set(model, [...(index.get(model) ?? []), collection]);
}

/** Registers the columns that decide membership: the scope column or junction, and the `where` columns. */
function registerInterest(storage: StorageAdapter | undefined, bound: BoundCollection): void {
  const { scope } = bound;
  const where = Object.keys(bound.where);
  if (scope.kind === "column") {
    storage?.registerInterest(bound.model, [scope.column, ...where]);
    return;
  }
  storage?.registerInterest(modelKey(scope.model), [scope.entry, scope.scope]);
  if (where.length > 0) {
    storage?.registerInterest(bound.model, where);
  }
}

/**
 * The routes of `registry`'s collections. Registers their membership columns
 * with the storage adapter. Throws a `TypeError` for an anchor this
 * dispatcher cannot authorize a scope through.
 */
export function bindCollections(
  registry: Registry,
  storage: StorageAdapter | undefined,
): CollectionRoutes {
  const byModel = new Map<string, BoundCollection[]>();
  const byJunction = new Map<string, BoundCollection[]>();
  const byAnchorModel = new Map<string, BoundCollection[]>();
  const byName = new Map<string, BoundCollection>();
  for (const service of registry.services.values()) {
    for (const collection of service.collections.values()) {
      if (service.model === undefined) {
        continue;
      }
      const anchorService = anchorOf(registry, service, collection);
      const bound: BoundCollection = Object.freeze({
        ...collection,
        service,
        model: modelKey(service.model),
        anchorService,
      });
      byName.set(`${service.name}\u0000${collection.name}`, bound);
      add(byModel, bound.model, bound);
      if (bound.scope.kind === "via") {
        add(byJunction, modelKey(bound.scope.model), bound);
      }
      if (anchorService?.model !== undefined) {
        add(byAnchorModel, modelKey(anchorService.model), bound);
      }
      registerInterest(storage, bound);
    }
  }
  return Object.freeze({
    byModel,
    byJunction,
    byAnchorModel,
    find: (service: string, name: string) => byName.get(`${service}\u0000${name}`),
  });
}

/** The collection state of a dispatcher: its routes, its subscriptions and its resume buffer. */
export function createCollectionState(
  registry: Registry,
  storage: StorageAdapter | undefined,
): CollectionState {
  const buffer = createDeltaBuffer();
  return {
    routes: bindCollections(registry, storage),
    scopes: new ScopeIndex(buffer),
    buffer,
  };
}
