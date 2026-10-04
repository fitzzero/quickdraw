"use client";

// Client exports for @fitzzero/quickdraw-core/client (RFC 0003 section 11).
//
// The directive above must stay the first statement: esbuild keeps an entry
// point's directives, so it opens dist/client/index.js and marks the whole
// entry as client code for React Server Components
// (scripts/dist-smoke.mjs checks it). A server component therefore cannot
// call anything exported here; it imports `createServerCaller` and the
// helpers from `@fitzzero/quickdraw-core/utils`, which this entry re-exports
// for client code.
//
// The layers: `createQuickdrawConnection`, `call`, the invalidation
// coordinator and the overlay store are plain TypeScript, with no React and
// no DOM, for React Native and Node clients; the provider and the typed
// client's hooks sit on top.

// Isomorphic helpers, the HTTP server caller and the cache keys (also on ./utils).
export * from "../utils";

// The auth routes kit's browser side (sign in, sign out) and bearer-token
// storage, which reads localStorage where there is one.
export {
  clearAuthToken,
  getAuthToken,
  setAuthToken,
  signInUrl,
  signOut,
  signOutEverywhere,
  type AuthRoutesTarget,
  type SignInUrlOptions,
} from "./auth";

// The connection and calls, without React.
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
  shouldRetry,
  type CallRequest,
  type CallResult,
} from "./call";
export { reloadOncePerSession } from "./reload";
export type { JoinWait, TopicWatch } from "./watch";
export {
  DEFAULT_SUBSCRIPTION_LANE,
  type LaneCallback,
  type SubscriptionEvent,
  type SubscriptionLane,
} from "./lane";

// Invalidation and optimistic overlays, without React.
export {
  DEFAULT_INVALIDATION_WINDOW_MS,
  RECONNECT_JITTER_MS,
  createInvalidationCoordinator,
  type CoordinatorOptions,
  type InvalidateOptions,
  type InvalidationCoordinator,
  type ReconnectRefetchOptions,
} from "./coordinator";
export {
  overlaysOf,
  type OptimisticCache,
  type OptimisticUpdate,
  type OverlayStore,
  type OverlayView,
} from "./optimistic";
export { refetchOnAccessChanges, sessionOf, type CacheSession, type HelloChange } from "./session";

// Live entities and collections, without React: the state the hooks show
// (cached under `entityKey` and `collectionKey`), the pure merge functions
// behind it, and the stores a connection and `QueryClient` share.
export {
  applyDeltas as applyCollectionDeltas,
  applyFrames as applyCollectionFrames,
  applyItems as applyCollectionItems,
  applyKept as applyCollectionKept,
  applyPage as applyCollectionPage,
  applySnapshot as applyCollectionSnapshot,
  emptyCollection,
  type CollectionItem,
  type CollectionState,
  type DeltaBatch,
  type DeltaOptions,
  type DeltaResult,
  type KeptResult,
  type PageReply,
} from "./live/collectionStore";
export type { CollectionShape, IndexRow } from "./live/collectionIndex";
export type { CollectionEntry, CollectionTarget } from "./live/collectionLoads";
export type { CollectionController, ResumeReason } from "./live/collectionController";
export type { CollectionHub, ScopeHolding, ScopeOptions } from "./live/collections";
export type { EntityEntry } from "./live/entities";
export type { EntityStore } from "./live/entityStore";
export { liveDataOf, type LiveData } from "./live/liveData";
// Stream feeds, typed event handlers and app-room presence, without React
// (RFC 0003 section 12.5): the stores the realtime hooks read.
export {
  PENDING_STREAM,
  STREAM_DEFAULT_MAX,
  STREAM_MAX_ITEMS,
  feedKey,
  type StreamState,
  type StreamStore,
  type StreamTarget,
} from "./live/streams";
export type { EventBus, EventHandler } from "./live/events";
export type { PresenceStore } from "./live/presence";

// The typed client and its provider.
export { createQuickdrawClient } from "./createClient";
export type {
  AdminMembers,
  CollectionMember,
  EntityMembers,
  LiveMembers,
  MethodMember,
  MutationCallOptions,
  MutationMember,
  MutationVariables,
  OptimisticCacheOf,
  QueryCallOptions,
  QueryMember,
  QuickdrawClient,
  QuickdrawInvalidate,
  ServiceClient,
} from "./clientTypes";
export type { UseCollectionOptions, UseCollectionResult } from "./live/useCollection";
export type { UseEntitiesResult, UseEntityOptions, UseEntityResult } from "./live/useEntity";
// Streams, channels, typed events and presence (RFC 0003 section 12.5):
// `qd.<service>.<stream>.useStream`, `.<channel>.useChannel`,
// `.<event>.useEvent`, and `usePresence(room)`.
export type {
  ChannelMember,
  EventMember,
  GlobalStreamMember,
  RealtimeMembers,
  ScopedStreamMember,
  StreamMember,
} from "./live/memberTypes";
export type { UseChannelResult } from "./live/useChannel";
export type { UseEventOptions } from "./live/useEvent";
export type { UseStreamOptions, UseStreamResult } from "./live/useStream";
export { usePresence } from "./live/usePresence";
export { SEARCH_DEBOUNCE_MS } from "./live/useSearch";
export type {
  SearchMember,
  SearchMemberOf,
  UseSearchOptions,
  UseSearchResult,
} from "./live/searchTypes";
// The admin kit's client half (RFC 0003 section 12.4): `qd.<service>.admin`
// on the typed client, the services an admin screen can show, and one
// shape of every service's admin members for a screen driven by `adminMeta`.
export {
  useAdminServices,
  type AdminKeysOf,
  type AdminServiceInfo,
  type UseAdminServicesOptions,
  type UseAdminServicesResult,
} from "./admin";
export {
  adminOf,
  type AdminListRequest,
  type AdminMutationMember,
  type AdminQueryMember,
  type AdminRow,
  type AdminScreen,
  type AdminWriteData,
} from "./adminScreen";
export type { MethodMutationOptions, MethodQueryOptions } from "./hooks";
export {
  QuickdrawProvider,
  useQuickdraw,
  type QuickdrawProviderProps,
  type QuickdrawStatus,
} from "./provider";
