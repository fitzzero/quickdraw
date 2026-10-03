// The collections of one dispatcher's live data (RFC 0003 section 7): the
// state they keep on the hub, the flush sink that sends their deltas, the
// socket listeners of `qd:col:sub`, `qd:col:items` and `qd:col:unsub`, their
// half of revocation, and `dispatcher.collections.reset` for the rare change
// tracked writes cannot describe. Change topics (`../topics.ts`) are built on
// the same state.

import type { AnyContract } from "../../contract/defineContract";
import type { Hub } from "../emit/hub";
import { nextRev } from "../rev";
import { createCollectionState, type CollectionHub } from "./bind";
import { createCollectionSink } from "./collectionSink";
import { collectionSubscriptions } from "./extension";
import { createScopeRevocation } from "./revocation";
import { sendFrame } from "./send";

/** What a dispatcher's live data gets from its collections. */
export interface LiveCollections {
  /** The hub, now holding the collections' state. */
  readonly hub: CollectionHub;
  /** Sends the flush's collection deltas: after the entity sink on the dispatcher's list. */
  readonly sink: ReturnType<typeof createCollectionSink>;
  /** Serves `qd:col:sub`, `qd:col:items` and `qd:col:unsub` on every v5 socket. */
  readonly extension: ReturnType<typeof collectionSubscriptions>;
  /** Re-authorizes collection scopes on access changes. */
  readonly revocation: ReturnType<typeof createScopeRevocation>;
  /** Sends one scope a `reset`, so its clients load it again. */
  reset(contract: AnyContract, collection: string, scope: string): void;
}

/** Gives `hub` its collections. Throws a `TypeError` for an anchor the dispatcher cannot authorize through. */
export function createLiveCollections(hub: Hub): LiveCollections {
  const withCollections: CollectionHub = Object.assign(hub, {
    collections: createCollectionState(hub.registry, hub.storage),
  });
  return Object.freeze({
    hub: withCollections,
    sink: createCollectionSink(withCollections),
    extension: collectionSubscriptions(withCollections),
    revocation: createScopeRevocation(withCollections),
    reset(contract: AnyContract, collection: string, scope: string): void {
      const service = (contract as { readonly name?: unknown } | null)?.name;
      const found =
        typeof service === "string"
          ? withCollections.collections.routes.find(service, collection)
          : undefined;
      if (found === undefined) {
        throw new TypeError(
          `collections.reset: ${String(service)} has no collection "${collection}" this dispatcher serves`,
        );
      }
      if (typeof scope !== "string" || scope.length === 0) {
        throw new TypeError("collections.reset: scope must be the scope's value, as in its room");
      }
      sendFrame(withCollections, withCollections.io, found, scope, nextRev(), [{ t: "reset" }]);
    },
  });
}
