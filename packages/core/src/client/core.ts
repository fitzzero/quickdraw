// The client without React: @fitzzero/quickdraw-core/client/core (RFC 0003
// section 11). A Node script, a CLI or a worker that opens a connection and
// calls methods imports this entry with neither React nor TanStack Query
// installed: nothing it reaches imports them, at run time or in its types,
// and it carries no "use client" directive, so a server-side runtime loads
// it as plain code (scripts/dist-smoke.mjs checks all three, and runs a
// script against a built server with React and TanStack refused).
//
// A script holds live data here too: `liveStoreOf` runs the live stores the
// hooks use over a cache of its own, and `holdCollection`, `holdEntity` and
// `holdStream` read rows, collection scopes and stream feeds from it.
//
// `./client` re-exports all of it, the same functions, beside what needs
// React or a TanStack `QueryClient`: the provider and the typed client's
// hooks, the invalidation coordinator, the overlay store, the cache session
// and the live data of a `QueryClient` (`liveDataOf`). Those take a
// `QueryClient` in their types, so they stay there; a module here imports
// none of them (`peer/`, `host/` and the live store included).

// Isomorphic helpers, the HTTP server caller and the cache keys (also on ./utils).
export * from "../utils";

// The auth routes kit's browser side (sign in, sign out) and bearer-token
// storage, which reads localStorage where there is one.
export {
  clearAuthToken,
  getAuthToken,
  setAuthToken,
  authProviders,
  signInUrl,
  signOut,
  signOutEverywhere,
  type AuthProviderInfo,
  type AuthRoutesTarget,
  type SignInUrlOptions,
} from "./auth";

// The connection and calls.
export {
  createQuickdrawConnection,
  type ConnectionAuth,
  type ConnectionRefusal,
  type ConnectionState,
  type ConnectionStatus,
  type QuickdrawConnection,
  type QuickdrawConnectionOptions,
  type QuickdrawSocket,
  type SocketClientOptions,
} from "./connection";
export { DEFAULT_BACKOFF_MS, type BackoffKind, type BackoffWindows } from "./backoff";
export {
  call,
  callData,
  isNotModified,
  isUnknownOutcome,
  shouldRetry,
  type CallRequest,
  type CallResult,
} from "./call";
export { reloadOncePerSession } from "./reload";
export { newId } from "./newId";
export type { JoinWait, TopicWatch } from "./watch";
export {
  DEFAULT_SUBSCRIPTION_LANE,
  type LaneCallback,
  type SubscriptionEvent,
  type SubscriptionLane,
} from "./lane";

// A script's live data (RFC 0003 section 11.5): the live stores of one
// connection over a cache of their own, and what a script holds of them.
export { liveStoreOf, type LiveStore } from "./live/liveStore";
export { holdCollection, type HoldCollectionTarget } from "./live/holdCollection";
export { holdEntity, type HoldEntityTarget } from "./live/holdEntity";
export { holdStream, type HoldStreamTarget } from "./live/holdStream";
export type {
  CollectionHolding,
  CollectionSnapshot,
  EntitySnapshot,
  Holding,
  StreamSnapshot,
} from "./live/holding";

// Peer links between two sockets of an app room (RFC 0003 section 12.5):
// WebRTC data channels, or the server's relay when those cannot form.
export {
  createPeerLink,
  DEFAULT_ICE_SERVERS,
  onPeerRequest,
  type PeerClock,
  type PeerCloseReason,
  type PeerConnectionConfig,
  type PeerIceServer,
  type PeerLabel,
  type PeerLink,
  type PeerLinkEvents,
  type PeerLinkLag,
  type PeerLinkLagOptions,
  type PeerLinkOptions,
  type PeerLinkState,
  type PeerLinkStats,
  type PeerPath,
  type PeerRequest,
  type RelayMode,
} from "./peer/index";
// Host mode (RFC 0003 section 12.5): a client serves a contract's
// host-served channels and streams as the host of an app room.
export {
  defineHost,
  hostOf,
  onHostChange,
  type Host,
  type HostChannelContext,
  type HostChannelHandler,
  type HostDefinition,
  type HostImplementation,
  type HostListener,
  type HostPeer,
  type HostStream,
  type HostStreamOptions,
} from "./host/index";
