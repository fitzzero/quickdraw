"use client";

import { useServiceQuery as useQuickdrawServiceQuery } from "@fitzzero/quickdraw-core/client";
import type { ServiceMethodsMap } from "@project/shared";
import type { GetPayload, GetResponse } from "./service-types";

interface UseServiceQueryOptions<TResponse> {
  enabled?: boolean;
  staleTime?: number;
  invalidateOn?: string[];
  onSuccess?: (data: TResponse) => void;
}

/** Typed wrapper around quickdraw-core's useServiceQuery hook. */
export function useServiceQuery<
  TService extends keyof ServiceMethodsMap,
  TMethod extends keyof ServiceMethodsMap[TService] & string,
>(
  serviceName: TService,
  methodName: TMethod,
  payload: GetPayload<TService, TMethod>,
  options?: UseServiceQueryOptions<GetResponse<TService, TMethod>>,
) {
  return useQuickdrawServiceQuery<GetPayload<TService, TMethod>, GetResponse<TService, TMethod>>(
    serviceName as string,
    methodName,
    payload,
    options,
  );
}
