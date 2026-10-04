"use client";

// quickdraw-migrate: review [v4-api] 4.x API useServiceQuery (removed): lint's no-v4-api names each replacement
import { useServiceQuery } from "@fitzzero/quickdraw-core/client";

// The service is chosen at run time: admin screens read any service
export function AdminCount({ serviceName }: { serviceName: string }) {
  // quickdraw-migrate: review [client] this 4.x hook call was not converted: it names the service or method at run time. Call the typed client's member (qd.<service>.<method>) instead
  const { data } = useServiceQuery<{ page: number }, { total: number }>(serviceName, "adminList", {
    page: 1,
  });
  return <span>{data?.total ?? 0}</span>;
}
