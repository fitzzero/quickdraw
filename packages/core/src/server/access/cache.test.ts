// The access cache (RFC 0003 section 4.2): lookups memoized per call, kept
// across requests only with `cacheMs`, and evicted by tracked writes to the
// columns and membership tables policies read, which also fire
// `onAccessChanged` (section 4.4). Unit tests of the store first, then the
// eviction rules against PGlite through a real dispatcher.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineContract, mutation } from "../../index";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { captureLogger, deferred } from "../__tests__/fixtures";
import type { AccessChange, AccessOptions, Dispatcher } from "../index";
import { createRegistry } from "../registry";
import { as, projectService, qd, seedBoard, taskService, type Board } from "./__tests__/board";
import { createAccessCache, createRequestMemo, lookup, namespace } from "./cache";
import { createPolicyEngine } from "./engine";

describe("the cache store", () => {
  it("keeps values per namespace, scope and row until they expire", () => {
    let now = 1_000;
    const cache = createAccessCache({ ttlMs: 50, now: () => now });
    const rows = namespace("rows");
    const members = namespace("members");
    cache.set(rows, "", "p1", { ownerId: "ada" });
    cache.set(members, "bo", "p1", "Moderate");
    cache.set(members, "cy", "p1", null);
    expect(cache.get(rows, "", "p1")).toEqual({ value: { ownerId: "ada" } });
    expect(cache.get(members, "cy", "p1")).toEqual({ value: null });
    expect(cache.get(members, "di", "p1")).toBeUndefined();
    expect(cache.size).toBe(3);
    now += 50;
    expect(cache.get(rows, "", "p1")).toBeUndefined();
    expect(cache.size).toBe(2);
  });

  it("evicts one value, a row in every scope, or a namespace, and moves its generation", () => {
    const cache = createAccessCache({ ttlMs: 1_000 });
    const members = namespace("members");
    const other = namespace("other");
    const fill = (): void => {
      for (const user of ["bo", "cy"]) {
        for (const row of ["p1", "p2"]) {
          cache.set(members, user, row, "Read");
        }
      }
      cache.set(other, "", "p1", "Admin");
    };
    fill();
    cache.evict(members, "bo", "p1");
    expect(cache.get(members, "bo", "p1")).toBeUndefined();
    expect(cache.get(members, "cy", "p1")).toBeDefined();
    cache.evict(members, undefined, "p2");
    expect([cache.get(members, "bo", "p2"), cache.get(members, "cy", "p2")]).toEqual([
      undefined,
      undefined,
    ]);
    expect(cache.size).toBe(2);
    cache.evict(members);
    expect(cache.size).toBe(1);
    expect(cache.get(other, "", "p1")).toEqual({ value: "Admin" });
    expect([cache.generation(members), cache.generation(other)]).toEqual([3, 0]);
    fill();
    cache.evict(members, "bo");
    expect([cache.get(members, "bo", "p1"), cache.get(members, "bo", "p2")]).toEqual([
      undefined,
      undefined,
    ]);
    expect(cache.get(members, "cy", "p2")).toEqual({ value: "Read" });
    expect(cache.size).toBe(3);
  });

  it("drops expired values, then everything, past maxEntries", () => {
    let now = 0;
    const cache = createAccessCache({ ttlMs: 10, maxEntries: 2, now: () => now });
    const ns = namespace("rows");
    cache.set(ns, "", "a", 1);
    now = 5;
    cache.set(ns, "", "b", 2);
    now = 12;
    cache.set(ns, "", "c", 3);
    expect([cache.get(ns, "", "a"), cache.get(ns, "", "b")]).toEqual([undefined, { value: 2 }]);
    cache.set(ns, "", "d", 4);
    expect(cache.size).toBe(1);
    expect(cache.get(ns, "", "d")).toEqual({ value: 4 });
  });
});

describe("lookup", () => {
  const ns = namespace("rows");

  it("loads only what the memo and the cache miss, in one batch, and memoizes in flight", async () => {
    const cache = createAccessCache({ ttlMs: 1_000 });
    cache.set(ns, "", "cached", "from the cache");
    const where = { memo: createRequestMemo(), cache, keepable: () => true };
    const load = vi.fn((ids: readonly string[]) =>
      Promise.resolve(new Map(ids.filter((id) => id !== "gone").map((id) => [id, `row ${id}`]))),
    );
    const [first, second] = await Promise.all([
      lookup(where, ns, "", ["a", "b", "a", "cached", "gone"], load),
      lookup(where, ns, "", ["b", "a"], load),
    ]);
    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith(["a", "b", "gone"]);
    expect([...first]).toEqual([
      ["cached", "from the cache"],
      ["a", "row a"],
      ["b", "row b"],
      ["gone", null],
    ]);
    expect(second.get("a")).toBe("row a");
    expect(cache.get(ns, "", "gone")).toEqual({ value: null });
  });

  it("keeps nothing that was evicted while it loaded, read in a transaction, or failed", async () => {
    const cache = createAccessCache({ ttlMs: 1_000 });
    const gate = deferred();
    const racing = lookup(
      { memo: createRequestMemo(), cache, keepable: () => true },
      ns,
      "",
      ["a"],
      async (ids) => {
        await gate.promise;
        return new Map(ids.map((id) => [id, "stale"]));
      },
    );
    cache.evict(ns, "", "a");
    gate.resolve();
    expect((await racing).get("a")).toBe("stale");
    expect(cache.get(ns, "", "a")).toBeUndefined();

    const inTransaction = { memo: createRequestMemo(), cache, keepable: () => false };
    await lookup(inTransaction, ns, "", ["b"], () =>
      Promise.resolve(new Map([["b", "uncommitted"]])),
    );
    expect(cache.get(ns, "", "b")).toBeUndefined();

    const memo = createRequestMemo();
    const failing = { memo, cache, keepable: () => true };
    const load = vi.fn(() => Promise.reject(new Error("down")));
    await expect(lookup(failing, ns, "", ["c"], load)).rejects.toThrow("down");
    await expect(lookup(failing, ns, "", ["c"], load)).rejects.toThrow("down");
    expect(load).toHaveBeenCalledOnce();
    expect(cache.get(ns, "", "c")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Eviction by tracked writes, against PGlite.
// ---------------------------------------------------------------------------

const memberContract = defineContract("memberService", {
  methods: {
    remove: mutation({
      input: z.object({ projectId: z.string(), userId: z.string() }),
      output: z.null(),
    }),
  },
});

const memberService = qd.defineService(memberContract, {
  methods: {
    remove: {
      access: "authenticated",
      handler: async ({ input, db }) => {
        await db.projectMember.delete({ where: { projectId_userId: input } });
        return null;
      },
    },
  },
});

let h: Harness;
let board: Board;

beforeAll(async () => {
  h = await createHarness();
}, 60_000);

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.database.reset();
  board = await seedBoard(h.prisma);
});

type Services = readonly [typeof projectService, typeof taskService, typeof memberService];

function boardDispatcher(access: AccessOptions = { cacheMs: 60_000 }) {
  const changes: AccessChange[] = [];
  const dispatcher: Dispatcher<Services> = qd.createDispatcher({
    services: [projectService, taskService, memberService],
    db: h.db,
    access,
  });
  dispatcher.access.onAccessChanged((change) => {
    changes.push(change);
  });
  return { dispatcher, changes };
}

/** The statements one `levelsFor` issued, and the level it found. */
async function lookupOf(
  dispatcher: Dispatcher<Services>,
  service: string,
  userId: string,
  id: string,
): Promise<[number, string | null]> {
  const counted = await h.storage.countStatements(() =>
    dispatcher.access.levelsFor(service, as(userId), [id]),
  );
  return [counted.statements, counted.value.get(id) ?? null];
}

describe("keeping lookups across requests", () => {
  it("reads afresh on every call without cacheMs, and once with it", async () => {
    const { dispatcher } = boardDispatcher({});
    expect(await lookupOf(dispatcher, "taskService", board.bo, board.t1)).toEqual([3, "Moderate"]);
    expect(await lookupOf(dispatcher, "taskService", board.bo, board.t1)).toEqual([3, "Moderate"]);
    const cached = boardDispatcher().dispatcher;
    expect(await lookupOf(cached, "taskService", board.bo, board.t1)).toEqual([3, "Moderate"]);
    expect(await lookupOf(cached, "taskService", board.bo, board.t1)).toEqual([0, "Moderate"]);
    // Another user shares the rows read, and reads only their own memberships.
    expect(await lookupOf(cached, "taskService", board.cy, board.t1)).toEqual([1, "Read"]);
  });

  it("keeps nothing read inside a transaction, which may still roll back", async () => {
    const { dispatcher } = boardDispatcher();
    await h.db.$transaction(async () => {
      await dispatcher.access.levelsFor("projectService", as(board.bo), [board.p1]);
    });
    expect(await lookupOf(dispatcher, "projectService", board.bo, board.p1)).toEqual([
      2,
      "Moderate",
    ]);
  });

  it("forgets what it kept once cacheMs passes", async () => {
    const { dispatcher } = boardDispatcher({ cacheMs: 30 });
    expect(await lookupOf(dispatcher, "projectService", board.bo, board.p1)).toEqual([
      2,
      "Moderate",
    ]);
    expect(await lookupOf(dispatcher, "projectService", board.bo, board.p1)).toEqual([
      0,
      "Moderate",
    ]);
    await new Promise((resolve) => {
      setTimeout(resolve, 60);
    });
    expect(await lookupOf(dispatcher, "projectService", board.bo, board.p1)).toEqual([
      2,
      "Moderate",
    ]);
  });
});

describe("eviction by tracked writes", () => {
  it("deleting a membership row evicts the member's level and fires onAccessChanged", async () => {
    const { dispatcher, changes } = boardDispatcher();
    expect(await lookupOf(dispatcher, "taskService", board.bo, board.t1)).toEqual([3, "Moderate"]);
    await dispatcher.run(() =>
      h.db.projectMember.delete({
        where: { projectId_userId: { projectId: board.p1, userId: board.bo } },
      }),
    );
    expect(changes).toEqual([{ service: "projectService", id: board.p1, userId: board.bo }]);
    // Only the membership is read again: the task's project is still kept.
    expect(await lookupOf(dispatcher, "taskService", board.bo, board.t1)).toEqual([1, null]);
    expect(await lookupOf(dispatcher, "taskService", board.cy, board.t1)).toEqual([1, "Read"]);
  });

  it("takes effect on the very next call when a method revokes a member", async () => {
    const { dispatcher } = boardDispatcher();
    const bo = dispatcher.caller(as(board.bo));
    await expect(bo.taskService.get({ id: board.t1 })).resolves.toMatchObject({ title: "T1" });
    await dispatcher
      .caller(as(board.ada))
      .memberService.remove({ projectId: board.p1, userId: board.bo });
    await expect(bo.taskService.get({ id: board.t1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("evicts a kept deny when a membership grants access", async () => {
    const { dispatcher, changes } = boardDispatcher();
    expect(await lookupOf(dispatcher, "projectService", board.ed, board.p1)).toEqual([2, null]);
    expect(await lookupOf(dispatcher, "projectService", board.ed, board.p1)).toEqual([0, null]);
    await dispatcher.run(() =>
      h.db.projectMember.create({ data: { projectId: board.p1, userId: board.ed, role: "Read" } }),
    );
    expect(changes).toEqual([{ service: "projectService", id: board.p1, userId: board.ed }]);
    expect(await lookupOf(dispatcher, "projectService", board.ed, board.p1)).toEqual([1, "Read"]);
  });

  it("evicts a member's old and new rows when a membership moves", async () => {
    const { dispatcher, changes } = boardDispatcher();
    await lookupOf(dispatcher, "projectService", board.bo, board.p1);
    await lookupOf(dispatcher, "projectService", board.bo, board.p2);
    await dispatcher.run(() =>
      h.db.projectMember.update({
        where: { projectId_userId: { projectId: board.p1, userId: board.bo } },
        data: { projectId: board.p2 },
      }),
    );
    expect(changes).toEqual([
      { service: "projectService", id: board.p1, userId: board.bo },
      { service: "projectService", id: board.p2, userId: board.bo },
    ]);
    expect(await lookupOf(dispatcher, "projectService", board.bo, board.p1)).toEqual([1, null]);
    expect(await lookupOf(dispatcher, "projectService", board.bo, board.p2)).toEqual([
      1,
      "Moderate",
    ]);
  });

  it("evicts the whole membership table for a write it cannot place (a touch)", async () => {
    const { dispatcher, changes } = boardDispatcher();
    await lookupOf(dispatcher, "projectService", board.bo, board.p1);
    await lookupOf(dispatcher, "projectService", board.cy, board.p1);
    const membership = await h.prisma.projectMember.findFirstOrThrow({
      where: { userId: board.cy },
    });
    await dispatcher.run(() => {
      h.storage.unitOfWork.touch?.("projectMember", [membership.id]);
    });
    expect(changes).toEqual([{ service: "projectService" }]);
    expect(await lookupOf(dispatcher, "projectService", board.bo, board.p1)).toEqual([
      1,
      "Moderate",
    ]);
    expect(await lookupOf(dispatcher, "projectService", board.cy, board.p1)).toEqual([1, "Read"]);
  });

  it("evicts the whole membership table when an update cannot say where its row went", async () => {
    const { dispatcher, changes } = boardDispatcher();
    expect(await lookupOf(dispatcher, "projectService", board.ed, board.p1)).toEqual([2, null]);
    // In an array-form transaction updateMany returns no rows, so no after values.
    await dispatcher.run(() =>
      h.db.$transaction([
        h.db.projectMember.updateMany({ where: { userId: board.bo }, data: { userId: board.ed } }),
      ]),
    );
    expect(changes).toEqual([{ service: "projectService" }]);
    expect(await lookupOf(dispatcher, "projectService", board.ed, board.p1)).toEqual([
      1,
      "Moderate",
    ]);
  });

  it("evicts a row whose owner or access list changes, for every user", async () => {
    const { dispatcher, changes } = boardDispatcher();
    expect(await lookupOf(dispatcher, "projectService", board.ada, board.p1)).toEqual([2, "Admin"]);
    expect(await lookupOf(dispatcher, "projectService", board.ed, board.p1)).toEqual([1, null]);
    await dispatcher.run(() =>
      h.db.project.update({ where: { id: board.p1 }, data: { ownerId: board.ed } }),
    );
    expect(changes).toEqual([{ service: "projectService", id: board.p1 }]);
    expect(await lookupOf(dispatcher, "projectService", board.ada, board.p1)).toEqual([1, null]);
    expect(await lookupOf(dispatcher, "projectService", board.ed, board.p1)).toEqual([0, "Admin"]);
    await dispatcher.run(() =>
      h.db.project.update({
        where: { id: board.p1 },
        data: { acl: [{ userId: board.ada, level: "Moderate" }] },
      }),
    );
    expect(await lookupOf(dispatcher, "projectService", board.ada, board.p1)).toEqual([
      1,
      "Moderate",
    ]);
  });

  it("keeps everything when a write sets no column a policy reads", async () => {
    const { dispatcher, changes } = boardDispatcher();
    await lookupOf(dispatcher, "taskService", board.ada, board.t1);
    await dispatcher.run(async () => {
      await h.db.project.update({ where: { id: board.p1 }, data: { name: "Renamed" } });
      await h.db.task.update({ where: { id: board.t1 }, data: { title: "Retitled" } });
    });
    expect(changes).toEqual([]);
    expect(await lookupOf(dispatcher, "taskService", board.ada, board.t1)).toEqual([0, "Admin"]);
  });

  it("evicts a task's parent link when the task moves, and reports the task", async () => {
    const { dispatcher, changes } = boardDispatcher();
    expect(await lookupOf(dispatcher, "taskService", board.ada, board.t1)).toEqual([3, "Admin"]);
    await dispatcher.run(() =>
      h.db.task.update({ where: { id: board.t1 }, data: { projectId: board.p2 } }),
    );
    expect(changes).toEqual([{ service: "taskService", id: board.t1 }]);
    expect(await lookupOf(dispatcher, "taskService", board.ada, board.t1)).toEqual([3, null]);
  });

  it("forgets a deleted row's members, and a created row's kept deny", async () => {
    const { dispatcher, changes } = boardDispatcher();
    expect(await lookupOf(dispatcher, "taskService", board.ada, "t-new")).toEqual([1, null]);
    await dispatcher.run(() =>
      h.db.task.create({ data: { id: "t-new", projectId: board.p1, title: "New" } }),
    );
    // A create is reported: subscribers of a deleted row with that id are authorized again.
    expect(changes).toEqual([{ service: "taskService", id: "t-new" }]);
    changes.length = 0;
    // The kept "no such task" is gone; its project is read for the first time.
    expect(await lookupOf(dispatcher, "taskService", board.ada, "t-new")).toEqual([3, "Admin"]);
    await dispatcher.run(() => h.db.project.delete({ where: { id: board.p2 } }));
    expect(changes).toEqual([{ service: "projectService", id: board.p2 }]);
  });
});

describe("forgetting what another process changed", () => {
  it("evicts what an access change names, a regranted user's levels, or a whole service", async () => {
    const engine = createPolicyEngine({
      registry: createRegistry([projectService, taskService]),
      storage: h.storage,
      logger: captureLogger(),
      cacheMs: 60_000,
    });
    const lookupNow = async (userId: string): Promise<[number, string | null]> => {
      const counted = await h.storage.countStatements(() =>
        engine.levelsFor("taskService", as(userId), [board.t1]),
      );
      return [counted.statements, counted.value.get(board.t1) ?? null];
    };
    expect(await lookupNow(board.bo)).toEqual([3, "Moderate"]);
    expect(await lookupNow(board.bo)).toEqual([0, "Moderate"]);
    // The project's columns and the member's level on it are read again; the task's are kept.
    engine.forget({ service: "projectService", id: board.p1, userId: board.bo });
    expect(await lookupNow(board.bo)).toEqual([2, "Moderate"]);
    engine.forget({ userId: board.bo });
    expect(await lookupNow(board.bo)).toEqual([1, "Moderate"]);
    engine.forget({ service: "taskService" });
    expect(await lookupNow(board.bo)).toEqual([1, "Moderate"]);
    engine.forget({ service: "unknownService" });
    expect(await lookupNow(board.bo)).toEqual([0, "Moderate"]);
  });
});

describe("onAccessChanged", () => {
  it("awaits its listeners before the flush moves on, logs their failures, and unsubscribes", async () => {
    const logger = captureLogger();
    const dispatcher = qd.createDispatcher({
      services: [projectService, taskService],
      db: h.db,
      logger,
    });
    const seen: string[] = [];
    const stop = dispatcher.access.onAccessChanged(async (change) => {
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
      seen.push(`${change.service} ${change.userId ?? "*"}`);
    });
    dispatcher.access.onAccessChanged(() => {
      throw new Error("listener broke");
    });
    await dispatcher.run(() => h.db.projectMember.deleteMany({ where: { projectId: board.p1 } }));
    expect(seen.sort()).toEqual([`projectService ${board.bo}`, `projectService ${board.cy}`]);
    expect(logger.at("error").map((entry) => entry.message)).toEqual([
      "An onAccessChanged listener failed",
      "An onAccessChanged listener failed",
    ]);
    stop();
    await dispatcher.run(() =>
      h.db.projectMember.create({ data: { projectId: board.p2, userId: board.ada, role: "Read" } }),
    );
    expect(seen).toHaveLength(2);
    expect(() => dispatcher.access.onAccessChanged("no" as never)).toThrow(
      "listener must be a function",
    );
  });

  it("reports nothing for a dispatcher whose services have no policy", async () => {
    const plain = qd.createDispatcher({ services: [memberService], db: h.db });
    const listener = vi.fn();
    plain.access.onAccessChanged(listener);
    await plain.run(() => h.db.projectMember.deleteMany({}));
    expect(listener).not.toHaveBeenCalled();
  });
});
