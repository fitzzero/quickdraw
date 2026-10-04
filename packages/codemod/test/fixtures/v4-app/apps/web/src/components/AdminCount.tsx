"use client";

import { useServiceQuery } from "@fitzzero/quickdraw-core/client";

// The service is chosen at run time: admin screens read any service
export function AdminCount({ serviceName }: { serviceName: string }) {
  const { data } = useServiceQuery<{ page: number }, { total: number }>(serviceName, "adminList", {
    page: 1,
  });
  return <span>{data?.total ?? 0}</span>;
}
