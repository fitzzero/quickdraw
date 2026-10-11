// A server's deployment (the 5.1 audit's RT-2): its `cluster.keyPrefix`,
// which tags every event it sends to the other nodes; a listener applies
// its own deployment's events and an untagged one (a node of an earlier
// version, warned once), and answers another deployment's without applying
// them (logged once). Two deployments on one bus are
// `deployments.test.ts`'s.

import { describe, expect, it, vi } from "vitest";
import { captureLogger } from "../__tests__/fixtures";
import type { QuickdrawIo } from "../transports/types";
import {
  deploymentOf,
  emitToNodes,
  onNodeEvent,
  registerClusterDeployment,
  registerDeployment,
  tagged,
} from "./deployment";

/** A server that records what it sends to the other nodes and the listeners it registers. */
function fakeServer() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const sent: unknown[][] = [];
  const io = {
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, listener);
    },
    serverSideEmit(...args: unknown[]) {
      sent.push(args);
      return true;
    },
  };
  return { io: io as unknown as QuickdrawIo, listeners, sent };
}

describe("a server's deployment", () => {
  it("is its cluster.keyPrefix, quickdraw without one, and tags what it sends", () => {
    const { io, sent } = fakeServer();
    expect(tagged(io, { userId: "u1" })).toEqual({ userId: "u1", deployment: "quickdraw" });
    registerDeployment(io, "prod");
    expect(deploymentOf(io)).toBe("prod");
    emitToNodes(io, "quickdraw:disconnect-user", { userId: "u1" });
    expect(sent).toEqual([["quickdraw:disconnect-user", { userId: "u1", deployment: "prod" }]]);
  });

  it("refuses a cluster.keyPrefix that is not a non-empty string", () => {
    const { io } = fakeServer();
    expect(() => registerClusterDeployment(io, { keyPrefix: "" })).toThrow(
      "createServer: cluster.keyPrefix must be a non-empty string",
    );
    expect(() => registerClusterDeployment(io, { keyPrefix: 7 })).toThrow(TypeError);
    registerClusterDeployment(io, undefined);
    expect(deploymentOf(io)).toBe("quickdraw");
  });
});

describe("onNodeEvent", () => {
  it("handles its own deployment's events, and answers another's without handling them, logging once", () => {
    const { io, listeners } = fakeServer();
    registerDeployment(io, "prod");
    const logger = captureLogger();
    const handled: unknown[] = [];
    onNodeEvent(
      io,
      logger,
      "quickdraw:grants",
      (payload, answer) => {
        handled.push(payload);
        answer(true);
      },
      "foreign answer",
    );
    const listener = listeners.get("quickdraw:grants");
    const acks = [vi.fn(), vi.fn(), vi.fn()];
    listener?.({ userId: "u1", deployment: "prod" }, acks[0]);
    listener?.({ userId: "u2", deployment: "staging" }, acks[1]);
    listener?.({ userId: "u3", deployment: "staging" }, acks[2]);
    expect(handled).toEqual([{ userId: "u1", deployment: "prod" }]);
    expect(acks.map((ack) => ack.mock.calls)).toEqual([
      [[true]],
      [["foreign answer"]],
      [["foreign answer"]],
    ]);
    const errors = logger.at("error").map(({ message }) => message);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('cluster.keyPrefix "staging"');
    expect(logger.at("warn")).toEqual([]);
  });

  it("handles an event without a deployment, from a node of an earlier version, warning once", () => {
    const { io, listeners } = fakeServer();
    registerDeployment(io, "prod");
    const logger = captureLogger();
    const handled: unknown[] = [];
    onNodeEvent(io, logger, "quickdraw:room-leave", (payload) => {
      handled.push(payload);
    });
    listeners.get("quickdraw:room-leave")?.({ room: "lobby", userId: "u1" });
    listeners.get("quickdraw:room-leave")?.({ room: "lobby", userId: "u2" });
    expect(handled).toEqual([
      { room: "lobby", userId: "u1" },
      { room: "lobby", userId: "u2" },
    ]);
    expect(logger.at("warn").map(({ message }) => message)).toEqual([
      "A node sent quickdraw:room-leave without its deployment: a node of an earlier quickdraw version, during a rolling deploy. Its events are applied; none arrives once every node runs this version",
    ]);
    expect(logger.at("error")).toEqual([]);
  });
});
