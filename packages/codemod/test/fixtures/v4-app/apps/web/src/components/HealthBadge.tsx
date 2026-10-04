"use client";

import { useServiceQuery } from "@fitzzero/quickdraw-core/client";

// The generic core hook, typed by hand
export function HealthBadge() {
  const { data } = useServiceQuery<Record<string, never>, { ok: true; at: string }>(
    "healthService",
    "ping",
    {},
  );
  return <small>{data?.ok ? `up since ${data.at}` : "down"}</small>;
}
