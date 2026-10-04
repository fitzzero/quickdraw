"use client";

import { qd } from "../lib/quickdraw";
// The generic core hook, typed by hand
export function HealthBadge() {
  const { data } = qd.healthService.ping.useQuery(
    {},
  );
  return <small>{data?.ok ? `up since ${data.at}` : "down"}</small>;
}
