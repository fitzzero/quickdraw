// Client exports for @quickdraw/core/client

// Provider and context
export { QuickdrawProvider, useQuickdrawSocket } from "./QuickdrawProvider";

// Hooks
export { useService, useServiceMethod } from "./useService";
export { useServiceQuery } from "./useServiceQuery";
export { useSubscription } from "./useSubscription";
export { useRoomEvents } from "./useRoomEvents";
export { useChannelSend } from "./useChannelSend";

// Types
export type {
  QuickdrawSocketContextValue,
  QuickdrawProviderProps,
  UseServiceOptions,
  UseServiceResult,
  UseServiceQueryOptions,
  UseServiceQueryResult,
  UseSubscriptionOptions,
  UseSubscriptionResult,
  UseRoomEventsOptions,
  UseChannelSendResult,
  ClientServiceMethodMap,
  SubscriptionDataMap,
} from "./types";

// Socket inputs
export * from "./inputs";

// Client utilities (auth, formatting, navigation)
export {
  formatCurrency,
  formatNumber,
  formatDate,
  formatDateTime,
  truncate,
  formatPercent,
  getAuthToken,
  setAuthToken,
  clearAuthToken,
  parseJWTPayload,
  getOAuthUrl,
  logout,
  logoutAllDevices,
  findNavItemByHref,
  findParentNavItem,
  buildBreadcrumbs,
  routeRequiresAuth,
  type JWTPayload,
  type NavItem,
  type BreadcrumbItem,
} from "./utils";
