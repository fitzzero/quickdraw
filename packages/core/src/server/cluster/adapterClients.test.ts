// The watch on a node's adapter clients, against clients that stand in for
// node-redis: a subscription that comes back sends this node's sockets
// `qd:rotate`; a publish the client fails is logged once per outage, never
// left unhandled. Its run against a real Valkey is the cluster project's
// (`test/cluster/resync.test.ts`).

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { captureLogger, tick } from "../__tests__/fixtures";
import type { QuickdrawIo } from "../transports/types";
import { RESYNC_WITHIN_MS, watchAdapterClients } from "./adapterClients";

class FakeClient extends EventEmitter {
  readonly published: unknown[][] = [];
  fail = false;
  publish(...args: unknown[]): Promise<number> {
    this.published.push(args);
    return this.fail ? Promise.reject(new Error("TimeoutError")) : Promise.resolve(1);
  }
}

function fakeIo(adapter: object) {
  const local: unknown[][] = [];
  const io = {
    sockets: { adapter },
    local: {
      emit: (...args: unknown[]) => {
        local.push(args);
        return true;
      },
    },
  };
  return { io: io as unknown as QuickdrawIo, local };
}

describe("watching a node's adapter clients", () => {
  it("sends this node's sockets qd:rotate each time the subscription is ready again", () => {
    const subClient = new FakeClient();
    const { io, local } = fakeIo({ pubClient: new FakeClient(), subClient });
    const logger = captureLogger();
    watchAdapterClients(io, logger);
    watchAdapterClients(io, logger);
    subClient.emit("ready");
    expect(local).toEqual([["qd:rotate", { withinMs: RESYNC_WITHIN_MS }]]);
    expect(logger.at("info").map(({ message }) => message)).toEqual([
      "This node's Valkey subscription is back; its clients reconnect to catch up on what it missed",
    ]);
    subClient.emit("ready");
    expect(local).toHaveLength(2);
  });

  it("logs a publish the client failed once per outage, and leaves no rejection unhandled", async () => {
    const pubClient = new FakeClient();
    const { io } = fakeIo({ pubClient, subClient: new FakeClient() });
    const logger = captureLogger();
    watchAdapterClients(io, logger);
    pubClient.fail = true;
    // The adapter publishes without waiting for the result: nothing handles these.
    void pubClient.publish("frames", "one");
    void pubClient.publish("frames", "two");
    await tick();
    expect(pubClient.published).toEqual([
      ["frames", "one"],
      ["frames", "two"],
    ]);
    expect(logger.at("warn")).toHaveLength(1);
    // A caller that awaits a publish still hears of its failure.
    await expect(pubClient.publish("frames", "three")).rejects.toThrow("TimeoutError");
    // Ready again: the next outage is logged again.
    pubClient.emit("ready");
    void pubClient.publish("frames", "four");
    await tick();
    expect(logger.at("warn")).toHaveLength(2);
  });

  it("does nothing for an adapter without Valkey clients", () => {
    const { io, local } = fakeIo({ rooms: new Map() });
    expect(() => {
      watchAdapterClients(io, captureLogger());
    }).not.toThrow();
    expect(local).toEqual([]);
  });
});
