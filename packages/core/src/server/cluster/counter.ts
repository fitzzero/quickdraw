// The shared revision counter of a cluster (pack H, child 2): one key in the
// Valkey (or Redis) behind the Socket.IO adapter, which every node takes its
// flush revisions from, so revisions from different nodes are one total
// order instead of clocks that agree only within their skew.
//
// The counter stays in the range of the clocks revisions came from before:
// a script makes it `max(last + 1, the server's time in ms, the caller's
// floor + 1)` in one round trip, so revisions a client already holds, and
// the `versionColumn` times "not modified" compares them with, stay
// comparable, and a node never gets a revision below one it issued. Reading
// it (`current`) is one GET.
//
// Valkey may stop answering. A command that fails, or does not answer within
// `timeoutMs`, makes the counter answer `undefined` (the caller falls back to
// its own clock) and logs one error; while it is degraded no command is sent
// (none would queue behind a dead connection) until `RETRY_MS` passed and the
// client says it is ready, and the first command that answers again logs
// that the counter is back.

import { createHash } from "node:crypto";
import type { Logger } from "../../contract/logger";
import type { Revision } from "../../protocol/envelope";
import { describeError } from "../pipeline/metrics";
import { DEFAULT_CLUSTER_TIMEOUT_MS, within } from "./acks";

/**
 * A Valkey or Redis client the cluster helpers send commands through: a
 * node-redis client (`redis` 4 to 6) as it is, or an ioredis one through
 * {@link clusterClientOf}.
 */
export interface ClusterClient {
  /** Sends one command, `["GET", key]`, and resolves with its reply. */
  sendCommand(args: string[]): Promise<unknown>;
  /** False while the client is not connected; commands sent then would wait in its queue. */
  readonly isReady?: boolean;
}

/** The counter script: the next revision, above the caller's floor, never below the server's clock. */
export const REVISION_SCRIPT = [
  "if redis.replicate_commands then redis.replicate_commands() end",
  "local time = redis.call('TIME')",
  "local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)",
  "local last = tonumber(redis.call('GET', KEYS[1]) or '0')",
  "local floor = tonumber(ARGV[1]) or 0",
  "local rev = math.max(last + 1, now, floor + 1)",
  "return redis.call('INCRBY', KEYS[1], rev - last)",
].join("\n");

const REVISION_SCRIPT_SHA = createHash("sha1").update(REVISION_SCRIPT).digest("hex");

/** How long a degraded counter waits before it tries Valkey again. */
export const RETRY_MS = 1000;

/** A cluster's shared revision counter, as one node sees it. */
export interface SharedCounter {
  /**
   * A new revision: the counter, moved past `floor` (the last revision this
   * node issued) and the server's clock. `undefined` when Valkey did not
   * answer: the node then uses its own clock.
   */
  next(floor: Revision): Promise<Revision | undefined>;
  /** The counter's last revision (0 before the first), or `undefined` when Valkey did not answer. */
  current(): Promise<Revision | undefined>;
  /** True while Valkey is not answering. */
  degraded(): boolean;
}

/** Options of {@link createSharedCounter}. */
export interface SharedCounterOptions {
  readonly client: ClusterClient;
  readonly key: string;
  readonly logger: Logger;
  readonly timeoutMs?: number;
  /** The clock retries are timed with; tests pass their own. */
  readonly now?: () => number;
}

/** A reply that should be a whole number of milliseconds, read. */
function revisionIn(reply: unknown): Revision {
  const value = typeof reply === "string" ? Number(reply) : reply;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`the counter answered ${String(reply)}, not a revision`);
  }
  return value;
}

function noScript(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("NOSCRIPT");
}

/** Creates the counter at `key`, sending its commands through `client`. */
export function createSharedCounter(options: SharedCounterOptions): SharedCounter {
  const { client, key, logger } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLUSTER_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  let down = false;
  let retryAt = 0;

  const failed = (error: unknown): undefined => {
    retryAt = now() + RETRY_MS;
    if (!down) {
      down = true;
      logger.error(
        "The shared revision counter did not answer; this node takes revisions from its own clock until it does",
        { category: "quickdraw.cluster", key, error: describeError(error) },
      );
    }
    return undefined;
  };

  const send = async (args: string[]): Promise<Revision | undefined> => {
    if (client.isReady === false) {
      return failed(new Error("the client is not connected"));
    }
    if (down && now() < retryAt) {
      return undefined;
    }
    try {
      const reply = await within(
        Promise.resolve().then(() => client.sendCommand(args)),
        timeoutMs,
      );
      if (down) {
        down = false;
        logger.info("The shared revision counter answers again", {
          category: "quickdraw.cluster",
          key,
        });
      }
      return revisionIn(reply ?? 0);
    } catch (error) {
      if (noScript(error)) {
        throw error;
      }
      return failed(error);
    }
  };

  return Object.freeze({
    async next(floor: Revision): Promise<Revision | undefined> {
      const floorArg = String(Math.max(0, Math.floor(floor)));
      try {
        return await send(["EVALSHA", REVISION_SCRIPT_SHA, "1", key, floorArg]);
      } catch {
        // The script is not cached on this server yet (or any more): send it whole.
        return await send(["EVAL", REVISION_SCRIPT, "1", key, floorArg]);
      }
    },
    current: () => send(["GET", key]),
    degraded: () => down,
  });
}

/**
 * The client `value` stands for, or `undefined`: a node-redis client (it has
 * `sendCommand(args)` and `isReady`), or an ioredis one (`call` and
 * `status`), wrapped to look the same.
 */
export function clusterClientOf(value: unknown): ClusterClient | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as {
    readonly call?: unknown;
    readonly status?: unknown;
    readonly sendCommand?: unknown;
  };
  if (typeof candidate.call === "function" && typeof candidate.status === "string") {
    const call = candidate.call as (command: string, ...args: string[]) => Promise<unknown>;
    return {
      sendCommand: ([command = "", ...args]) => call.call(value, command, ...args),
      get isReady() {
        return (value as { readonly status: unknown }).status === "ready";
      },
    };
  }
  if (typeof candidate.sendCommand === "function") {
    return value as ClusterClient;
  }
  return undefined;
}
