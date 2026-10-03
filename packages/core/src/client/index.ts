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
// The layers: `createQuickdrawConnection` and `call` are plain TypeScript,
// with no React and no DOM, for React Native and Node clients; the provider
// and the typed client's hooks sit on top.

// Isomorphic helpers, the HTTP server caller and the cache keys (also on ./utils).
export * from "../utils";

// Token storage and logout helpers, which read localStorage (browser only).
export {
  clearAuthToken,
  getAuthToken,
  getOAuthUrl,
  logout,
  logoutAllDevices,
  setAuthToken,
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

// The typed client and its provider.
export { createQuickdrawClient } from "./createClient";
export type {
  LiveMembers,
  MethodMember,
  MutationCallOptions,
  MutationMember,
  MutationVariables,
  QueryCallOptions,
  QueryMember,
  QuickdrawClient,
  ServiceClient,
} from "./clientTypes";
export type { MethodMutationOptions, MethodQueryOptions } from "./hooks";
export {
  QuickdrawProvider,
  useQuickdraw,
  type QuickdrawProviderProps,
  type QuickdrawStatus,
} from "./provider";
