// The revisions of one dispatcher: the process's clock on one server, the
// cluster's counter behind a cluster adapter whose client the server can
// reach, never below a revision the dispatcher issued, and its own clock when
// the counter does not answer.

import { describe, expect, it } from "vitest";
import { captureLogger } from "../__tests__/fixtures";
import { currentRev } from "../rev";
import type { QuickdrawIo } from "../transports/types";
import { inRevisionOrder } from "../uow/flush";
import type { ClusterClient } from "./counter";
import { createRevisions, type RevisionHub } from "./revisions";

/** A client answering the counter script with `answers` in turn, and GET with `last`. */
function counterClient(answers: readonly (number | Error)[], last = 0) {
  const sent: string[][] = [];
  const queue = [...answers];
  const client: ClusterClient = {
    isReady: true,
    sendCommand(args: string[]) {
      sent.push(args);
      if (args[0] === "GET") {
        return Promise.resolve(String(last));
      }
      const answer = queue.shift();
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
  return { client, sent };
}

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
    const { client, sent } = counterClient([5_000_000_000_000, 4_000_000_000_000]);
    const revisions = createRevisions(clusteredHub(client, { keyPrefix: "app" }));
    expect(revisions.shared()).toBe(true);
    const first = revisions.forFlush();
    const second = revisions.forFlush();
    expect(await first?.()).toBe(5_000_000_000_000);
    // An answer below the last revision issued (a clock that jumped back) is moved past it.
    expect(await second?.()).toBe(5_000_000_000_001);
    expect(sent.map((args) => args.slice(2))).toEqual([
      ["1", "app:rev", "0"],
      ["1", "app:rev", "0"],
    ]);
    const third = revisions.forFlush();
    await third?.();
    expect(sent[2]?.slice(2)).toEqual(["1", "app:rev", "5000000000001"]);
  });

  it("take the process's clock when the counter does not answer, still above every one issued", async () => {
    const { client } = counterClient([9_000_000_000_000, new Error("ECONNRESET")]);
    const hub = clusteredHub(client);
    const revisions = createRevisions(hub);
    expect(await revisions.forFlush()?.()).toBe(9_000_000_000_000);
    expect(await revisions.forFlush()?.()).toBe(9_000_000_000_001);
    expect((hub.logger as ReturnType<typeof captureLogger>).at("error")).toHaveLength(1);
  });

  it("claim the counter's last revision for reads, and say when it moved past one", async () => {
    const { client } = counterClient([], 1_234);
    const revisions = createRevisions(clusteredHub(client));
    expect(await revisions.claim()).toBe(1_234);
    expect(await revisions.movedPast(1_000)).toBe(1_234);
    expect(await revisions.movedPast(1_234)).toBeUndefined();
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
