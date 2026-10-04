// Users' last-seen times across a cluster (RFC 0003 section 12.5, and the gap
// section 17 recorded for pack E): `presence.lastSeen(userId)` is now while
// any node holds a socket of the user, else the last time a node saw the
// user's last socket there disconnect. Each process keeps its own (bounded,
// `PresenceRecords`); behind a cluster's Valkey a node also writes it to
// `{keyPrefix}:seen:{userId}`, kept for `LAST_SEEN_TTL_MS` and never moved
// back, and an answer takes the later of the two. When Valkey does not
// answer, a node answers from its own records.

import type { Hub } from "../emit/hub";
import { DEFAULT_CLUSTER_TIMEOUT_MS, within } from "./acks";

/** How long a user's last-seen time is kept in the cluster's Valkey: 30 days. */
export const LAST_SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Writes the time unless a later one is there; keeps it `ARGV[2]` ms. */
const LAST_SEEN_SCRIPT = [
  "local kept = tonumber(redis.call('GET', KEYS[1]) or '0')",
  "if tonumber(ARGV[1]) > kept then",
  "  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])",
  "end",
  "return 1",
].join("\n");

function keyOf(prefix: string, userId: string): string {
  return `${prefix}:seen:${userId}`;
}

/** Records in the cluster's Valkey that `userId`'s last socket on this node disconnected `at`. */
export function recordLastSeen(hub: Hub, userId: string, at: number): void {
  const target = hub.revisions.counterClient();
  if (target === undefined || target.client.isReady === false) {
    return;
  }
  const key = keyOf(target.keyPrefix, userId);
  const args = ["EVAL", LAST_SEEN_SCRIPT, "1", key, String(at), String(LAST_SEEN_TTL_MS)];
  target.client.sendCommand(args).catch((error: unknown) => {
    hub.logger.debug("Recording a user's last-seen time in the cluster failed", {
      category: "quickdraw.presence",
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/** The last time any node of the cluster saw `userId` leave, or `undefined` (one server, none kept, no answer). */
export async function readLastSeen(hub: Hub, userId: string): Promise<number | undefined> {
  const target = hub.revisions.counterClient();
  if (target === undefined || target.client.isReady === false) {
    return undefined;
  }
  const timeoutMs = hub.cluster?.timeoutMs ?? DEFAULT_CLUSTER_TIMEOUT_MS;
  try {
    const reply = await within(
      target.client.sendCommand(["GET", keyOf(target.keyPrefix, userId)]),
      timeoutMs,
    );
    const value = typeof reply === "string" ? Number(reply) : Number.NaN;
    return Number.isSafeInteger(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
