// Revocation settles every socket before the flush moves on (the 5.1 audit's
// DATA-I1): when one socket's re-resolution fails, the access sink still
// waits for the others, so a socket the flush demotes is out of its rooms
// before that flush's frames go out. It then rejects with the first failure,
// which the sink logs.

import { describe, expect, it } from "vitest";
import { deferred, tick } from "../__tests__/fixtures";
import type { Hub } from "./hub";
import { createRevocation, settleAll, type RevocationHook } from "./revocation";

/** A hub with no sockets and no subscriptions: only the hooks re-resolve anything. */
const hub = {
  subscriptions: { accessChanges: 0, matching: () => new Map(), entries: () => [] },
  io: undefined,
} as unknown as Hub;

/** One hook that fails at once, and one that finishes only when `gate` resolves. */
function hooks() {
  const gate = deferred();
  const finished: string[] = [];
  const failure = new Error("a socket's re-resolution failed");
  const failing: RevocationHook = {
    changed: () => Promise.reject(failure),
    regranted: () => Promise.reject(failure),
  };
  const waiting: RevocationHook = {
    changed: async () => {
      await gate.promise;
      finished.push("changed");
    },
    regranted: async () => {
      await gate.promise;
      finished.push("regranted");
    },
  };
  return { gate, finished, failure, failing, waiting };
}

/** Whether `promise` has settled yet. */
function settledFlag(promise: Promise<unknown>): { readonly settled: () => boolean } {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { settled: () => settled };
}

describe("revocation", () => {
  it("waits for every hook of a change before it rejects with the first failure", async () => {
    const { gate, finished, failure, failing, waiting } = hooks();
    const revocation = createRevocation(hub, [failing, waiting]);
    const changed = revocation.changed({ service: "taskService", id: "t1" }, false);
    const flag = settledFlag(changed);
    await tick();
    expect(flag.settled()).toBe(false);
    gate.resolve();
    await expect(changed).rejects.toBe(failure);
    expect(finished).toEqual(["changed"]);
  });

  it("waits for every hook of a grants change before it rejects with the first failure", async () => {
    const { gate, finished, failure, failing, waiting } = hooks();
    const revocation = createRevocation(hub, [failing, waiting]);
    const regranted = revocation.regranted("u1");
    const flag = settledFlag(regranted);
    await tick();
    expect(flag.settled()).toBe(false);
    gate.resolve();
    await expect(regranted).rejects.toBe(failure);
    expect(finished).toEqual(["regranted"]);
  });
});

describe("settleAll", () => {
  it("waits for every piece of work, then rejects with the first failure", async () => {
    const gate = deferred();
    let finished = false;
    const first = new Error("first");
    const settled = settleAll([
      Promise.reject(first),
      (async () => {
        await gate.promise;
        finished = true;
      })(),
      Promise.reject(new Error("second")),
    ]);
    const flag = settledFlag(settled);
    await tick();
    expect(flag.settled()).toBe(false);
    gate.resolve();
    await expect(settled).rejects.toBe(first);
    expect(finished).toBe(true);
  });

  it("keeps a failure that is no Error as the cause of the one it throws", async () => {
    await expect(settleAll([Promise.reject("not an error")])).rejects.toMatchObject({
      cause: "not an error",
    });
    await expect(settleAll([Promise.resolve(1), undefined])).resolves.toBeUndefined();
  });
});
