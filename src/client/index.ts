// Client exports for @quickdraw/core/client

// Provider and context
export { QuickdrawProvider, useQuickdrawSocket } from "./QuickdrawProvider";

// Hooks
export { useService, useServiceMethod } from "./useService";
export { useSubscription } from "./useSubscription";

// Types
export type {
  QuickdrawSocketContextValue,
  QuickdrawProviderProps,
  UseServiceOptions,
  UseServiceResult,
  UseSubscriptionOptions,
  UseSubscriptionResult,
  ClientServiceMethodMap,
  SubscriptionDataMap,
} from "./types";

// Socket inputs
export * from "./inputs";
