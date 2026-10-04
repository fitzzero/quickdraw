// A node's answered broadcasts against a server that stands in for Socket.IO
// behind the Redis adapter: they wait for every node's answer while every
// node answers, never while the publishing client is not connected, and
// after one broadcast went unanswered not until a probe is answered again
// (one error, one info). Their run against a real Valkey is the cluster
// project's (`test/cluster/broadcasts.test.ts`).

import { afterEach, describe, expect, it } from "vitest";
import { captureLogger, tick } from "../__tests__/fixtures";
import type { QuickdrawIo } from "../transports/types";
import { answerProbes, createClusterBroadcasts, PROBE_EVENT } from "./broadcasts";

/** A promise that never settles: a node that never answers. */
function never(): Promise<never> {
  return new Promise<never>(() => {
    // Nothing settles it.
  });
}

/** A server whose publishing client and answering nodes the test sets. */
function fakeServer() {
  const state = { ready: true, answering: true };
  const sent: { readonly event: unknown; readonly answered: boolean }[] = [];
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const io = {
    sockets: {
      adapter: {
        pubClient: {
          sendCommand: () => Promise.resolve(null),
          get isReady() {
            return state.ready;
          },
        },
      },
    },
    serverSideEmit(event: string) {
      sent.push({ event, answered: false });
      return true;
    },
    serverSideEmitWithAck(event: string) {
      sent.push({ event, answered: true });
      return state.answering ? Promise.resolve([]) : never();
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, listener);
    },
  };
  return { io: io as unknown as QuickdrawIo, state, sent, listeners };
}

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const closing: (() => void)[] = [];

afterEach(() => {
  for (const close of closing.splice(0)) {
    close();
  }
});

function broadcastsOf(io: QuickdrawIo) {
  const logger = captureLogger();
  const broadcasts = createClusterBroadcasts({ io, logger, timeoutMs: 30, probeMs: 10 });
  closing.push(broadcasts.close);
  return { broadcasts, logger };
}

describe("a node's answered broadcasts", () => {
  it("wait for every node's answer while every node answers", async () => {
    const { io, sent } = fakeServer();
    const { broadcasts, logger } = broadcastsOf(io);
    await broadcasts.broadcast("quickdraw:access-changed", { service: "taskService" });
    expect(sent).toEqual([{ event: "quickdraw:access-changed", answered: true }]);
    expect(broadcasts.degraded()).toBe(false);
    expect(logger.entries).toEqual([]);
  });

  it("do not wait while the publishing client is not connected", async () => {
    const { io, state, sent } = fakeServer();
    state.ready = false;
    state.answering = false;
    const { broadcasts, logger } = broadcastsOf(io);
    const started = performance.now();
    await broadcasts.broadcast("quickdraw:grants", { userId: "u1" });
    expect(performance.now() - started).toBeLessThan(25);
    expect(sent).toEqual([{ event: "quickdraw:grants", answered: false }]);
    // Not connected is not a node that failed to answer: nothing is degraded or logged.
    expect(broadcasts.degraded()).toBe(false);
    expect(logger.entries).toEqual([]);
  });

  it("stop waiting after one went unanswered, until every node answers a probe", async () => {
    const { io, state, sent } = fakeServer();
    const { broadcasts, logger } = broadcastsOf(io);
    state.answering = false;
    await broadcasts.broadcast("quickdraw:access-changed", { n: 1 });
    expect(broadcasts.degraded()).toBe(true);
    const outage = logger.at("error").map(({ message }) => message);
    expect(outage).toEqual([
      "A node did not answer a broadcast in time; this node sends access changes without waiting for the other nodes until every node answers a probe",
    ]);
    // Degraded: later broadcasts go out at once, unanswered.
    const started = performance.now();
    await broadcasts.broadcast("quickdraw:access-changed", { n: 2 });
    await broadcasts.broadcast("quickdraw:access-changed", { n: 3 });
    expect(performance.now() - started).toBeLessThan(25);
    expect(sent.slice(1, 3)).toEqual([
      { event: "quickdraw:access-changed", answered: false },
      { event: "quickdraw:access-changed", answered: false },
    ]);
    // Probes go out every 10 ms and stay unanswered: still degraded, still one error.
    await sleep(60);
    expect(sent.filter(({ event }) => event === PROBE_EVENT).length).toBeGreaterThanOrEqual(1);
    expect(broadcasts.degraded()).toBe(true);
    expect(logger.at("error")).toHaveLength(1);
    // Every node answers again: the next probe ends it, once.
    state.answering = true;
    await sleep(40);
    expect(broadcasts.degraded()).toBe(false);
    expect(logger.at("info").map(({ message }) => message)).toEqual([
      "Every node answers broadcasts again; access changes wait for them again",
    ]);
    const probes = sent.filter(({ event }) => event === PROBE_EVENT).length;
    await sleep(30);
    expect(sent.filter(({ event }) => event === PROBE_EVENT)).toHaveLength(probes);
    await broadcasts.broadcast("quickdraw:access-changed", { n: 4 });
    expect(sent.at(-1)).toEqual({ event: "quickdraw:access-changed", answered: true });
  });

  it("probe only while the publishing client is connected, and stop once closed", async () => {
    const { io, state, sent } = fakeServer();
    const { broadcasts } = broadcastsOf(io);
    state.answering = false;
    await broadcasts.broadcast("quickdraw:access-changed", {});
    state.ready = false;
    const before = sent.length;
    await sleep(40);
    expect(sent).toHaveLength(before);
    state.ready = true;
    broadcasts.close();
    await sleep(40);
    expect(sent).toHaveLength(before);
  });
});

describe("answering probes", () => {
  it("answers another node's probe at once", async () => {
    const { io, listeners } = fakeServer();
    answerProbes(io);
    const answers: unknown[] = [];
    listeners.get(PROBE_EVENT)?.((answer: unknown) => answers.push(answer));
    await tick();
    expect(answers).toEqual([true]);
  });
});
