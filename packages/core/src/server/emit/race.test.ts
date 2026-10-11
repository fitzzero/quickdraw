// `settleJoin` and `enterSettled` (`race.ts`) against a fake index of one
// record: a hub whose access changes a test moves by hand, and a socket whose
// principal it replaces. The suites of each subscribe kind (`topics.test.ts`,
// `realtime/streams.test.ts`) drive the same code through a real server; these
// pin each branch on its own.

import { describe, expect, it } from "vitest";
import type { QuickdrawServerSocket } from "../transports/types";
import type { Principal } from "../types";
import { enterSettled, raceStart, settleJoin, type JoinedRecord } from "./race";
import { MAX_RECHECKS } from "./subscribe";

interface Held {
  readonly anchors: readonly string[];
}

/** What one check does: changes the world while it reads, then answers. */
type Check = (world: World, record: Held) => readonly string[] | undefined;

class World {
  readonly hub = { subscriptions: { accessChanges: 0 } };
  readonly data: { principal: Principal | null } = { principal: { userId: "ada" } };
  readonly socket = { data: this.data } as unknown as QuickdrawServerSocket;
  current: Held | undefined;
  withdrawn = false;
  leaves = 0;
  readonly checked: Held[] = [];

  constructor(
    readonly own: Held,
    readonly check: Check,
  ) {
    this.current = own;
  }

  /** An access change was flushed. */
  moveAccess(): void {
    this.hub.subscriptions.accessChanges += 1;
  }

  joined(): JoinedRecord<Held> {
    return {
      current: () => this.current,
      withdrawn: () => this.withdrawn,
      authorize: async (record) => {
        this.checked.push(record);
        return await Promise.resolve(this.check(this, record));
      },
      reanchor: (_record, anchors) => {
        this.current = { anchors };
        return this.current;
      },
      leave: () => {
        this.leaves += 1;
        this.current = undefined;
      },
    };
  }

  /** Settles `own`, recorded after an access change moved since the subscribe began unless `still`. */
  async settle(options: { readonly still?: boolean } = {}): Promise<Held | undefined> {
    const start = raceStart(this.hub, this.socket);
    if (options.still !== true) {
      this.moveAccess();
    }
    return await settleJoin(this.hub, this.socket, start, this.own, this.joined());
  }
}

const own: Held = { anchors: ["project:p1"] };
const allowed: Check = (_world, record) => record.anchors;

describe("settleJoin", () => {
  it("keeps the record without a lookup when access stood still", async () => {
    const world = new World(own, allowed);
    expect(await world.settle({ still: true })).toBe(own);
    expect(world.checked).toEqual([]);
  });

  it("keeps a record the check after an access change allows with the same anchors", async () => {
    const world = new World(own, allowed);
    expect(await world.settle()).toBe(own);
    expect(world.checked).toEqual([own]);
    expect(world.current).toBe(own);
  });

  it("ends the record and refuses it when that check denies", async () => {
    const world = new World(own, () => undefined);
    await expect(world.settle()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(world.leaves).toBe(1);
    expect(world.current).toBeUndefined();
  });

  it("denies another identity without a lookup", async () => {
    const world = new World(own, allowed);
    const start = raceStart(world.hub, world.socket);
    world.data.principal = { userId: "bo" };
    await expect(
      settleJoin(world.hub, world.socket, start, own, world.joined()),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(world.checked).toEqual([]);
    expect(world.leaves).toBe(1);
  });

  it("checks the same user again when only the socket's principal was replaced", async () => {
    const world = new World(own, allowed);
    const start = raceStart(world.hub, world.socket);
    world.data.principal = { userId: "ada", serviceAccess: { taskService: "Read" } };
    expect(await settleJoin(world.hub, world.socket, start, own, world.joined())).toBe(own);
    expect(world.checked).toEqual([own]);
  });

  it("records a record allowed with other anchors again, so revocation finds it by them", async () => {
    const world = new World(own, () => ["project:p2"]);
    const settled = await world.settle();
    expect(settled).toEqual({ anchors: ["project:p2"] });
    expect(world.current).toBe(settled);
  });

  it("refuses a record revocation ended meanwhile, though the check allowed it", async () => {
    const world = new World(own, (w, record) => {
      w.current = undefined;
      return record.anchors;
    });
    await expect(world.settle()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(world.leaves).toBe(0);
  });

  it("answers nothing for a record the client withdrew meanwhile", async () => {
    const world = new World(own, (w, record) => {
      w.current = undefined;
      w.withdrawn = true;
      return record.anchors;
    });
    expect(await world.settle()).toBeUndefined();
    expect(world.leaves).toBe(0);
  });

  it("adopts a record revocation authorized again meanwhile, and settles it in turn", async () => {
    const replaced: Held = { anchors: ["project:p3"] };
    const world = new World(own, (w, record) => {
      if (record === own) {
        // Revocation recorded it again with its own anchors, and access moved on.
        w.current = replaced;
        w.moveAccess();
      }
      return record.anchors;
    });
    expect(await world.settle()).toBe(replaced);
    expect(world.checked).toEqual([own, replaced]);
  });

  it("ends a record revocation authorized again when this check denies", async () => {
    const world = new World(own, (w) => {
      w.current = { anchors: ["project:p3"] };
      return undefined;
    });
    await expect(world.settle()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(world.leaves).toBe(1);
    expect(world.current).toBeUndefined();
  });

  it(`checks at most ${MAX_RECHECKS} times, and keeps a record whose anchors stood`, async () => {
    const world = new World(own, (w, record) => {
      w.moveAccess();
      return record.anchors;
    });
    expect(await world.settle()).toBe(own);
    expect(world.checked).toHaveLength(MAX_RECHECKS);
  });

  it("refuses a record whose anchors the last check moved while access still moved", async () => {
    const world = new World(own, (w) => {
      w.moveAccess();
      return [`project:p${w.checked.length + 1}`];
    });
    await expect(world.settle()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(world.checked).toHaveLength(MAX_RECHECKS);
    expect(world.leaves).toBe(1);
  });

  it("keeps a record whose anchors an earlier check moved, once the last one moved nothing", async () => {
    const world = new World(own, (w) => {
      if (w.checked.length === 1) {
        w.moveAccess();
        return ["project:p2"];
      }
      return ["project:p2"];
    });
    expect(await world.settle()).toEqual({ anchors: ["project:p2"] });
    expect(world.checked).toHaveLength(2);
  });
});

describe("enterSettled", () => {
  it("answers the record the socket entered with", () => {
    expect(
      enterSettled(
        () => own,
        () => false,
      ),
    ).toBe(own);
  });

  it("answers nothing when the client withdrew the record", () => {
    expect(
      enterSettled(
        () => undefined,
        () => true,
      ),
    ).toBeUndefined();
  });

  it("refuses a record revocation ended after it settled", () => {
    expect(() =>
      enterSettled(
        () => undefined,
        () => false,
      ),
    ).toThrow(expect.objectContaining({ code: "FORBIDDEN" }) as Error);
  });
});
