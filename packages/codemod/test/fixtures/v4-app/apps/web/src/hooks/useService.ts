"use client";

import { useService as useQuickdrawService } from "@fitzzero/quickdraw-core/client";
import type { ServiceMethodsMap } from "@project/shared";
import type { GetPayload, GetResponse } from "./service-types";

interface UseServiceOptions<TResponse> {
  onSuccess?: (data: TResponse) => void;
  onError?: (error: string) => void;
  timeout?: number;
}

/** Typed wrapper around quickdraw-core's useService hook. */
export function useService<
  TService extends keyof ServiceMethodsMap,
  TMethod extends keyof ServiceMethodsMap[TService] & string,
>(
  serviceName: TService,
  methodName: TMethod,
  options?: UseServiceOptions<GetResponse<TService, TMethod>>,
) {
  return useQuickdrawService<GetPayload<TService, TMethod>, GetResponse<TService, TMethod>>(
    serviceName as string,
    methodName,
    options,
  );
}
