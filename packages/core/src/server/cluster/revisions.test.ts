// The revisions of one dispatcher: the process's clock on one server, the
// cluster's counter behind a cluster adapter whose client the server can
// reach, never below a revision the dispatcher issued, and its own clock when
// the counter does not answer or has no key. Revisions are microseconds since
// the epoch.

import { describe, expect, it } from "vitest";
import { captureLogger } from "../__tests__/fixtures";
import { currentRev, observeRev } from "../rev";
import type { QuickdrawIo } from "../transports/types";
import { inRevisionOrder } from "../uow/flush";
import type { ClusterClient } from "./counter";
import { createRevisions, type RevisionHub } from "./revisions";

/**
 * A client answering the counter script with `answers` in turn (the key was
 * there), and GET with `last` (`null`: no key; an `Error`: it fails).
 */
function counterClient(answers: readonly (number | Error)[], last: number | null | Error = 0) {
  const sent: string[][] = [];
  const queue = [...answers];
  const client: ClusterClient = {
    isReady: true,
    sendCommand(args: string[]) {
      sent.push(args);
      if (args[0] === "GET") {
        if (last instanceof Error) {
          return Promise.reject(last);
        }
        return Promise.resolve(last === null ? null : String(last));
      }
      const answer = queue.shift();
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve([answer, 1]);
    },
  };
  return { client, sent };
}

/** The clock as a revision, now. */
const clockNow = () => Date.now() * 1000;

/** A hub behind a cluster adapter whose publishing client is `pubClient`. */
function clusteredHub(pubClient: unknown, cluster?: RevisionHub["cluster"]): RevisionHub {
  return {
    io: { sockets: { adapter: { pubClient } } } as unknown as QuickdrawIo,
    probe: { local: () => false },
    logger: captureLogger(),
    cluster,
  };
}

describe("revisions", () => {
  it("are the process's clock on one server, at once", () => {
    const revisions = createRevisions({
      io: undefined,
      probe: { local: () => true },
      logger: captureLogger(),
      cluster: undefined,
    });
    expect(revisions.forFlush()).toBeUndefined();
    expect(revisions.shared()).toBe(false);
    expect(revisions.claim()).toBe(currentRev());
  });

  it("stay the process's behind a cluster adapter without a client the server can reach", () => {
    const revisions = createRevisions(clusteredHub(undefined));
    expect(revisions.forFlush()).toBeUndefined();
    expect(revisions.counterClient()).toBeUndefined();
  });

  it("come from the adapter's client, under the cluster's key prefix, never below one issued", async () => {
    const { client, sent } = counterClient([1_800_000_000_000_000, 1_799_000_000_000_000]);
    const revisions = createRevisions(clusteredHub(client, { keyPrefix: "app" }));
    expect(revisions.shared()).toBe(true);
    const first = revisions.forFlush();
    const second = revisions.forFlush();
    expect(await first?.()).toBe(1_800_000_000_000_000);
    // An answer below the last revision issued (a clock that jumped back) is moved past it.
    expect(await second?.()).toBe(1_800_000_000_000_001);
    expect(sent.map((args) => args.slice(2))).toEqual([
      ["1", "app:rev", "0"],
      ["1", "app:rev", "0"],
    ]);
    const third = revisions.forFlush();
    await third?.();
    expect(sent[2]?.slice(2)).toEqual(["1", "app:rev", "1800000000000001"]);
  });

  it("take the process's clock when the counter does not answer, still above every one issued", async () => {
    const { client } = counterClient([3_000_000_000_000_000, new Error("ECONNRESET")]);
    const hub = clusteredHub(client);
    const revisions = createRevisions(hub);
    expect(await revisions.forFlush()?.()).toBe(3_000_000_000_000_000);
    expect(await revisions.forFlush()?.()).toBe(3_000_000_000_000_001);
    expect((hub.logger as ReturnType<typeof captureLogger>).at("error")).toHaveLength(1);
  });

  it("claim the counter's last revision for reads, and say when it moved past one", async () => {
    const { client } = counterClient([], 1_790_000_000_001_234);
    const revisions = createRevisions(clusteredHub(client));
    expect(await revisions.claim()).toBe(1_790_000_000_001_234);
    expect(await revisions.movedPast(1_790_000_000_001_000)).toBe(1_790_000_000_001_234);
    expect(await revisions.movedPast(1_790_000_000_001_234)).toBeUndefined();
  });

  it("claim the clock, never 0, when the counter has no key: it is unknown", async () => {
    const { client } = counterClient([], null);
    const revisions = createRevisions(clusteredHub(client));
    const before = clockNow();
    expect(await revisions.claim()).toBeGreaterThanOrEqual(before);
    // No key: no node took a revision since it was made or lost, so nothing moved past one.
    expect(await revisions.movedPast(before - 1)).toBeUndefined();
  });

  it("claim the clock when the counter does not answer: the last revision taken may be old", async () => {
    // This process's last revision is ten minutes old.
    observeRev(clockNow() - 600_000_000);
    const { client } = counterClient([], new Error("ECONNRESET"));
    const revisions = createRevisions(clusteredHub(client));
    const before = clockNow();
    expect(await revisions.claim()).toBeGreaterThanOrEqual(before);
    // No answer: nothing reached this node from the others either.
    expect(await revisions.movedPast(before - 1)).toBeUndefined();
  });

  it("prefer cluster.client to the adapter's", async () => {
    const adapter = counterClient([1]);
    const given = counterClient([2]);
    const revisions = createRevisions(clusteredHub(adapter.client, { client: given.client }));
    expect(await revisions.forFlush()?.()).toBe(2);
    expect(adapter.sent).toEqual([]);
  });
});

describe("inRevisionOrder with shared revisions", () => {
  it("runs flushes in arrival order, each with the revision the counter gave it", async () => {
    const seen: number[] = [];
    let next = 100;
    const sink = inRevisionOrder(
      {
        flush: async (_writes, info) => {
          await new Promise((resolve) => {
            setTimeout(resolve, 1);
          });
          seen.push(info.rev);
        },
      },
      {
        forFlush: () => {
          next += 1;
          const rev = next;
          return () =>
            new Promise((resolve) => {
              setTimeout(
                () => {
                  resolve(rev);
                },
                5 - (rev % 5),
              );
            });
        },
      },
    );
    const info = { requestId: "r", transport: "internal" as const, rev: 1 };
    await Promise.all([sink.flush([], info), sink.flush([], info), sink.flush([], info)]);
    expect(seen).toEqual([101, 102, 103]);
  });
});
