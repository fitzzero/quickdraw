// The Valkey the cluster projects run against: the one
// `test/cluster/docker-compose.yml` starts on 127.0.0.1:6399, or the one
// QD_VALKEY_URL names (CI's service container). Every test cluster uses keys
// and channels under a prefix of its own, so test files running at once on
// one Valkey never hear each other.

import { randomUUID } from "node:crypto";
import { createClient } from "redis";

/** The Valkey of the cluster projects. */
export const VALKEY_URL = process.env.QD_VALKEY_URL ?? "redis://127.0.0.1:6399";

/** A client of the cluster projects' Valkey, not connected yet; its errors are swallowed (tests cut connections on purpose). */
export function valkeyClient(url = VALKEY_URL) {
  const client = createClient({ url });
  client.on("error", () => undefined);
  return client;
}

/** A node-redis client, as an app's Redis adapter has. */
export type ValkeyClient = ReturnType<typeof valkeyClient>;

/** A prefix no other test cluster uses, for adapter channels and counter keys. */
export function uniquePrefix(label = "cluster"): string {
  return `qd-test:${label}:${randomUUID().slice(0, 8)}`;
}

/** Closes a client however it stands: connected, reconnecting or closed. */
export async function closeClient(client: ValkeyClient): Promise<void> {
  if (client.isOpen) {
    try {
      await client.close();
    } catch {
      client.destroy();
    }
  }
}
