// The shared revision counter of a cluster (pack H, child 2): one key in the
// Valkey (or Redis) behind the Socket.IO adapter, which every node takes its
// flush revisions from, so revisions from different nodes are one total
// order instead of clocks that agree only within their skew.
//
// The counter keeps to the clock revisions are read against: a script makes
// it `max(last + 1, the server's time in microseconds, the caller's floor +
// 1)` in one round trip. In microseconds it moves past the clock only above
// a million flushes a second across the cluster, so revisions a client
// holds and the `versionColumn` times "not modified" compares them with
// stay comparable (`../rev.ts`), and a node never gets a revision below one
// it issued. Reading it (`current`) is one GET; a key Valkey does not have
// is unknown, never 0.
//
// The key has no TTL and must survive Valkey restarts and failovers
// (persistence or replication). When it is lost anyway, the script starts
// it again at the server's clock, above the node's floor: since the counter
// kept to the clock, that is above every revision issued before, unless the
// clock stepped back. A node that sees the key gone after it had seen it
// logs a warning.
//
// Valkey may stop answering. A command that fails, or does not answer within
// `timeoutMs`, makes the counter answer `undefined` (the caller falls back to
// its own clock) and logs one error. While it is degraded no call sends a
// command or waits: a call made once `RETRY_MS` passed (with the client
// connected) starts one probe in the background (a GET), and the probe that
// answers ends the outage, logging that the counter is back.

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

/**
 * The counter script: the next revision, above the caller's floor and never
 * below the server's clock in microseconds, and whether the key was there
 * (`[revision, 1 | 0]`).
 */
export const REVISION_SCRIPT = [
  "if redis.replicate_commands then redis.replicate_commands() end",
  "local time = redis.call('TIME')",
  "local now = tonumber(time[1]) * 1000000 + tonumber(time[2])",
  "local held = redis.call('GET', KEYS[1])",
  "local last = tonumber(held or '0')",
  "local floor = tonumber(ARGV[1]) or 0",
  "local rev = math.max(last + 1, now, floor + 1)",
  "return { redis.call('INCRBY', KEYS[1], rev - last), held and 1 or 0 }",
].join("\n");

const REVISION_SCRIPT_SHA = createHash("sha1").update(REVISION_SCRIPT).digest("hex");

/** How long a degraded counter waits before it probes Valkey again. */
export const RETRY_MS = 1000;

/** A cluster's shared revision counter, as one node sees it. */
export interface SharedCounter {
  /**
   * A new revision: the counter, moved past `floor` (the last revision this
   * node issued) and the server's clock. `undefined` when Valkey did not
   * answer: the node then uses its own clock.
   */
  next(floor: Revision): Promise<Revision | undefined>;
  /**
   * The counter's last revision; `null` when Valkey does not have the key
   * (no flush took one since the key was made or lost: unknown), and
   * `undefined` when Valkey did not answer.
   */
  current(): Promise<Revision | null | undefined>;
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

/** A reply that should be a whole number of microseconds, read. */
function revisionIn(reply: unknown): Revision {
  const value = typeof reply === "string" ? Number(reply) : reply;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`the counter answered ${String(reply)}, not a revision`);
  }
  return value;
}

/** The script's reply, read: the revision, and whether the key was there. */
function scriptReply(reply: unknown): { readonly rev: Revision; readonly held: boolean } {
  if (!Array.isArray(reply) || reply.length !== 2) {
    throw new TypeError(`the counter answered ${String(reply)}, not [revision, held]`);
  }
  return { rev: revisionIn(reply[0]), held: Number(reply[1]) === 1 };
}

function noScript(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("NOSCRIPT");
}

/** A counter's outages: one error each, a probe in the background, one info at the end. */
interface Outages {
  /** True while Valkey is not answering. */
  readonly down: () => boolean;
  /** A command failed or did not answer: the counter is degraded (logged once). */
  failed(error: unknown): undefined;
  /** While degraded: one GET in the background once the retry delay passed; nothing waits on it. */
  probe(): void;
}

function createOutages(
  options: SharedCounterOptions,
  timeoutMs: number,
  now: () => number,
): Outages {
  const { client, key, logger } = options;
  let down = false;
  let retryAt = 0;
  let probing = false;
  const recovered = (): void => {
    if (down) {
      down = false;
      logger.info("The shared revision counter answers again", {
        category: "quickdraw.cluster",
        key,
      });
    }
  };
  return {
    down: () => down,
    failed(error: unknown): undefined {
      retryAt = now() + RETRY_MS;
      if (!down) {
        down = true;
        logger.error(
          "The shared revision counter did not answer; this node takes revisions from its own clock until it does",
          { category: "quickdraw.cluster", key, error: describeError(error) },
        );
      }
      return undefined;
    },
    probe(): void {
      if (probing || now() < retryAt || client.isReady === false) {
        return;
      }
      probing = true;
      retryAt = now() + RETRY_MS;
      void within(
        Promise.resolve().then(() => client.sendCommand(["GET", key])),
        timeoutMs,
      )
        .then(recovered, () => {
          retryAt = now() + RETRY_MS;
        })
        .finally(() => {
          probing = false;
        });
    },
  };
}

/** Creates the counter at `key`, sending its commands through `client`. */
export function createSharedCounter(options: SharedCounterOptions): SharedCounter {
  const { client, key, logger } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLUSTER_TIMEOUT_MS;
  const outages = createOutages(options, timeoutMs, options.now ?? Date.now);
  /** This node saw the key: a script that finds it missing means it was lost. */
  let seen = false;

  const send = async (args: string[]): Promise<unknown> => {
    if (outages.down()) {
      outages.probe();
      return undefined;
    }
    if (client.isReady === false) {
      return outages.failed(new Error("the client is not connected"));
    }
    try {
      return await within(
        Promise.resolve().then(() => client.sendCommand(args)),
        timeoutMs,
      );
    } catch (error) {
      if (noScript(error)) {
        throw error;
      }
      return outages.failed(error);
    }
  };

  /** A revision from the script's reply, saying when the key it saw was lost. */
  const revisionOf = (reply: unknown): Revision | undefined => {
    try {
      const { rev, held } = scriptReply(reply);
      if (!held && seen) {
        logger.warn(
          "The revision counter key was lost; configure persistence or replication for it",
          { category: "quickdraw.cluster", key, rev },
        );
      }
      seen = true;
      return rev;
    } catch (error) {
      return outages.failed(error);
    }
  };

  return Object.freeze({
    async next(floor: Revision): Promise<Revision | undefined> {
      const floorArg = String(Math.max(0, Math.floor(floor)));
      let reply: unknown;
      try {
        reply = await send(["EVALSHA", REVISION_SCRIPT_SHA, "1", key, floorArg]);
      } catch {
        // The script is not cached on this server yet (or any more): send it whole.
        reply = await send(["EVAL", REVISION_SCRIPT, "1", key, floorArg]);
      }
      return reply === undefined ? undefined : revisionOf(reply);
    },
    async current(): Promise<Revision | null | undefined> {
      const reply = await send(["GET", key]);
      if (reply === undefined || reply === null) {
        return reply;
      }
      try {
        const rev = revisionIn(reply);
        seen = true;
        return rev;
      } catch (error) {
        return outages.failed(error);
      }
    },
    degraded: () => outages.down(),
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
