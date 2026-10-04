// The shared revision counter against a client that stands in for Valkey:
// the commands it sends, its fallback when Valkey does not answer (one error
// per outage, no command while degraded, back once it answers), and the
// clients it accepts. Its run against a real Valkey is the cluster project's
// (`test/cluster/order.test.ts`).

import { describe, expect, it } from "vitest";
import { captureLogger } from "../__tests__/fixtures";
import { answerOf, within } from "./acks";
import {
  clusterClientOf,
  createSharedCounter,
  REVISION_SCRIPT,
  RETRY_MS,
  type ClusterClient,
} from "./counter";

/** A promise that never settles: a command Valkey never answers. */
function never(): Promise<never> {
  return new Promise<never>(() => {
    // Nothing settles it.
  });
}

/** A client whose replies the test scripts: each command gets the next reply, or `fail`. */
function fakeClient(replies: readonly unknown[] = []) {
  const sent: string[][] = [];
  const queue = [...replies];
  const client: ClusterClient & { isReady: boolean } = {
    isReady: true,
    sendCommand(args: string[]) {
      sent.push(args);
      const reply = queue.shift();
      if (reply instanceof Error) {
        return Promise.reject(reply);
      }
      if (reply === "hang") {
        return never();
      }
      return Promise.resolve(reply);
    },
  };
  return { client, sent };
}

function counterWith(client: ClusterClient, clock = { now: 0 }, timeoutMs = 50) {
  const logger = captureLogger();
  const counter = createSharedCounter({
    client,
    key: "app:rev",
    logger,
    timeoutMs,
    now: () => clock.now,
  });
  return { counter, logger, clock };
}

describe("the shared counter", () => {
  it("takes a revision with the script, sending the node's floor, and reads the last one with GET", async () => {
    const { client, sent } = fakeClient([1_800_000_000_123, "1800000000123", null]);
    const { counter } = counterWith(client);
    expect(await counter.next(42)).toBe(1_800_000_000_123);
    expect(sent[0]?.slice(0, 1)).toEqual(["EVALSHA"]);
    expect(sent[0]?.slice(2)).toEqual(["1", "app:rev", "42"]);
    expect(await counter.current()).toBe(1_800_000_000_123);
    expect(await counter.current()).toBe(0);
    expect(sent.slice(1)).toEqual([
      ["GET", "app:rev"],
      ["GET", "app:rev"],
    ]);
  });

  it("sends the script whole when the server does not have it cached", async () => {
    const { client, sent } = fakeClient([new Error("NOSCRIPT No matching script"), 7]);
    const { counter, logger } = counterWith(client);
    expect(await counter.next(0)).toBe(7);
    expect(sent.map(([command]) => command)).toEqual(["EVALSHA", "EVAL"]);
    expect(sent[1]?.[1]).toBe(REVISION_SCRIPT);
    expect(logger.at("error")).toEqual([]);
  });

  it("answers nothing when Valkey fails, logs once per outage, sends nothing while degraded, and comes back", async () => {
    const { client, sent } = fakeClient([new Error("ECONNRESET"), 99]);
    const { counter, logger, clock } = counterWith(client);
    expect(await counter.next(0)).toBeUndefined();
    expect(counter.degraded()).toBe(true);
    expect(await counter.next(0)).toBeUndefined();
    expect(await counter.current()).toBeUndefined();
    // Nothing is sent before the retry delay passed.
    expect(sent).toHaveLength(1);
    expect(logger.at("error").map(({ message }) => message)).toEqual([
      "The shared revision counter did not answer; this node takes revisions from its own clock until it does",
    ]);
    clock.now += RETRY_MS;
    expect(await counter.next(0)).toBe(99);
    expect(counter.degraded()).toBe(false);
    expect(logger.at("error")).toHaveLength(1);
    expect(logger.at("info").map(({ message }) => message)).toEqual([
      "The shared revision counter answers again",
    ]);
  });

  it("falls back once a command does not answer within timeoutMs", async () => {
    const { client } = fakeClient(["hang"]);
    const { counter, logger } = counterWith(client, { now: 0 }, 10);
    expect(await counter.next(0)).toBeUndefined();
    expect(logger.at("error")).toHaveLength(1);
  });

  it("sends nothing through a client that is not connected: a command would wait in its queue", async () => {
    const { client, sent } = fakeClient([5]);
    client.isReady = false;
    const { counter, logger, clock } = counterWith(client);
    expect(await counter.next(0)).toBeUndefined();
    expect(sent).toEqual([]);
    expect(logger.at("error")).toHaveLength(1);
    client.isReady = true;
    clock.now += RETRY_MS;
    expect(await counter.next(0)).toBe(5);
  });

  it("refuses a reply that is not a revision, as a failure", async () => {
    const { client } = fakeClient(["not a number"]);
    const { counter, logger } = counterWith(client);
    expect(await counter.current()).toBeUndefined();
    expect(logger.at("error")).toHaveLength(1);
  });
});

describe("clusterClientOf", () => {
  it("takes a node-redis client as it is, wraps an ioredis one, and refuses anything else", async () => {
    const { client } = fakeClient([3]);
    expect(clusterClientOf(client)).toBe(client);
    const calls: unknown[][] = [];
    const ioredis = {
      status: "ready",
      call(...args: unknown[]) {
        calls.push(args);
        return Promise.resolve("ok");
      },
    };
    const wrapped = clusterClientOf(ioredis);
    expect(await wrapped?.sendCommand(["GET", "k"])).toBe("ok");
    expect(calls).toEqual([["GET", "k"]]);
    expect(wrapped?.isReady).toBe(true);
    ioredis.status = "reconnecting";
    expect(wrapped?.isReady).toBe(false);
    expect(clusterClientOf({})).toBeUndefined();
    expect(clusterClientOf(null)).toBeUndefined();
  });
});

describe("the cluster's waiting helpers", () => {
  it("bound a wait, and find an event's acknowledgement in its last argument", async () => {
    await expect(within(Promise.resolve(1), 10)).resolves.toBe(1);
    await expect(within(never(), 5)).rejects.toThrow("no answer within 5 ms");
    const answers: boolean[] = [];
    answerOf([{}, (done: boolean) => answers.push(done)])(true);
    answerOf([{}])(true);
    expect(answers).toEqual([true]);
  });
});
