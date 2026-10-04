"use client";

import { useSubscription as useQuickdrawSubscription } from "@fitzzero/quickdraw-core/client";
import type { SubscriptionDataMap } from "@project/shared";

interface UseSubscriptionOptions<TData> {
  enabled?: boolean;
  onData?: (data: TData) => void;
}

/** Typed wrapper around quickdraw-core's useSubscription hook. */
export function useSubscription<TService extends keyof SubscriptionDataMap>(
  serviceName: TService,
  entryId: string | null,
  options: UseSubscriptionOptions<SubscriptionDataMap[TService]> = {},
) {
  return useQuickdrawSubscription<SubscriptionDataMap[TService]>(
    serviceName as string,
    entryId,
    options,
  );
}
