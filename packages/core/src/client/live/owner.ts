// Which live data reads a connection's live frames (RFC 0003 section 11.5):
// the stores of a `QueryClient` (`liveData.ts`, which the hooks and the
// provider use) or a script's live store (`liveStore.ts`). Both would hold
// rows and scopes on the one socket, and each would unsubscribe the other's
// as it let go of its own, so a connection has one kind of live data: the
// first one made keeps it, and making the other kind on it throws.
//
// React-free, and TanStack-free.

import type { QuickdrawConnection } from "../connection";

/** The kind of live data a connection holds: a `QueryClient`'s, or a live store. */
export type LiveOwner = "queryClient" | "store";

const owners = new WeakMap<QuickdrawConnection, LiveOwner>();

const REFUSALS: Readonly<Record<LiveOwner, string>> = {
  store:
    "liveStoreOf: the live data of a QueryClient follows this connection (a QuickdrawProvider's, or liveDataOf's): read rows and scopes through it, or give the live store a connection of its own",
  queryClient:
    "liveDataOf: a live store (liveStoreOf) follows this connection: give the QueryClient's live data a connection of its own",
};

/** Records that live data of kind `owner` follows `connection`; throws when the other kind already does. */
export function claimLive(connection: QuickdrawConnection, owner: LiveOwner): void {
  const held = owners.get(connection);
  if (held !== undefined && held !== owner) {
    throw new Error(REFUSALS[owner]);
  }
  owners.set(connection, owner);
}
