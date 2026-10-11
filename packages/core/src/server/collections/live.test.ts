// Collections over time (RFC 0003 sections 4.4 and 7.3) through a real
// server against PGlite: resuming a scope from a revision, revocation when
// access changes or the anchor row is deleted, races between a subscribe and
// a flush or an access change, a cluster adapter, and the rate limiter.

import type { Server } from "socket.io";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inCluster } from "../../../test/cluster/mode";
import type { PrismaClient } from "../../../test/prisma/setup";
import { collectionRoom } from "../../index";
import { createHarness, pauseNext, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, emitWithAck, type TestApp } from "../../testing/index";
import { as, seedBoard, type Board } from "../access/__tests__/board";
import { projectService, recordingStorage, type Read } from "../emit/__tests__/live";
import { MAX_SCOPES_PER_SOCKET, type Principal, type ServiceGrants } from "../index";
import { peeredCluster } from "../transports/__tests__/harness";
import {
  colSub,
  colUnsub,
  defineTaskService,
  labelService,
  receiveScopes,
  taskContract,
} from "./__tests__/fixture";

let h: Harness;
let board: Board;
const apps: TestApp[] = [];

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

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => await app.close()));
});

interface StartOptions {
  /** Runs after each read through the framework's storage adapter, before its rows return. */
  readonly after?: (read: Read) => Promise<void> | undefined;
  /** Runs before each read through the framework's storage adapter is made. */
  readonly before?: (read: Read) => Promise<void> | undefined;
  readonly changeLog?: false;
  readonly adapter?: NonNullable<ConstructorParameters<typeof Server>[1]>["adapter"];
  readonly loadServiceAccess?: (userId: string) => ServiceGrants;
  readonly rateLimit?: { readonly maxRequests: number };
}

async function start(options: StartOptions = {}) {
  const recorded = recordingStorage(h.storage, options.after, options.before);
  const app = await createTestApp({
    services: [projectService, labelService, defineTaskService()],
    db: h.db,
    storage: recorded.storage,
    ...(options.changeLog === undefined ? {} : { changeLog: options.changeLog }),
    ...(options.adapter === undefined ? {} : { socket: { adapter: options.adapter } }),
    ...(options.loadServiceAccess === undefined
      ? {}
      : { auth: { loadServiceAccess: options.loadServiceAccess } }),
    ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
  });
  apps.push(app as unknown as TestApp);
  return { app, reads: recorded.reads };
}

type App = Awaited<ReturnType<typeof start>>["app"];

async function connect(app: App, principal: Principal) {
  const connection = await app.connect(principal);
  return { connection, scopes: receiveScopes(connection) };
}

function write<T>(app: App, fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  return app.server.dispatcher.run(async () => await fn(h.db));
}

function inRoom(app: App, collection: string, scope: string): number {
  const room = collectionRoom("taskService", collection, scope);
  return app.server.io.sockets.adapter.rooms.get(room)?.size ?? 0;
}

/** A page read: task rows with a limit. */
function isPageRead(read: Read): boolean {
  return read.model === "task" && read.args.take !== undefined;
}

/** Reads of task rows with an item's select: a page, or a flush's items. */
function itemReads(reads: readonly Read[]): Read[] {
  return reads.filter(
    (read) =>
      read.model === "task" &&
      typeof read.args.select === "object" &&
      read.args.select !== null &&
      "title" in read.args.select,
  );
}

const forbidden = { ok: false, e: { code: "FORBIDDEN", message: "Insufficient permissions" } };

describe("resume", () => {
  it("replays the deltas missed while away, in order, without reading a page, and joins again", async () => {
    const { app, reads } = await start();
    const watcher = await connect(app, as(board.ada));
    await colSub(watcher.connection, "byProject", board.p1);
    const away = await connect(app, as(board.ada));
    const first = await colSub(away.connection, "byProject", board.p1);
    await colUnsub(away.connection, "byProject", board.p1);
    const created = await write(app, (db) =>
      db.task.create({ data: { projectId: board.p1, title: "While away", ordinal: 3 } }),
    );
    await write(app, (db) =>
      db.task.update({ where: { id: board.t1 }, data: { title: "Renamed" } }),
    );
    await write(app, (db) => db.task.delete({ where: { id: created.id } }));
    reads.length = 0;
    const resumed = await colSub(away.connection, "byProject", board.p1, {
      since: first.rev as number,
    });
    if (inCluster()) {
      // Behind a cluster adapter a resume reads a page: a process's buffer sees its own flushes only.
      expect(resumed).toMatchObject({ ok: true, items: [{ id: board.t1, title: "Renamed" }] });
      expect(resumed).not.toHaveProperty("resumed");
    } else {
      expect(resumed).toEqual({
        ok: true,
        resumed: true,
        rev: expect.any(Number),
        deltas: [
          {
            t: "added",
            item: {
              id: created.id,
              projectId: board.p1,
              title: "While away",
              status: "open",
              ordinal: 3,
            },
          },
          { t: "patched", id: board.t1, d: { title: "Renamed" } },
          { t: "removed", id: created.id },
        ],
      });
      expect(itemReads(reads)).toEqual([]);
    }
    expect(resumed.rev as number).toBeGreaterThan(first.rev as number);
    expect(inRoom(app, "byProject", board.p1)).toBe(2);
    await write(app, (db) => db.task.update({ where: { id: board.t1 }, data: { title: "Live" } }));
    await away.scopes.settle();
    const live = inCluster()
      ? { t: "updated", item: expect.objectContaining({ id: board.t1, title: "Live" }) }
      : { t: "patched", id: board.t1, d: { title: "Live" } };
    expect(away.scopes.frames).toEqual([expect.objectContaining({ deltas: [live] })]);
  });

  it("resumes an unchanged scope with no deltas", async () => {
    const { app } = await start();
    const { connection } = await connect(app, as(board.ada));
    const first = await colSub(connection, "byProject", board.p1);
    const again = await colSub(connection, "byProject", board.p1, { since: first.rev as number });
    // Behind a cluster adapter a resume reads a page: a process's buffer sees its own flushes only.
    expect(again).toEqual(
      inCluster()
        ? { ...first, rev: expect.any(Number) }
        : { ok: true, resumed: true, rev: first.rev, deltas: [] },
    );
  });

  it("answers a page when the buffer no longer covers the revision", async () => {
    const { app } = await start();
    const { connection } = await connect(app, as(board.ada));
    const first = await colSub(connection, "byProject", board.p1);
    const old = await colSub(connection, "byProject", board.p1, {
      since: (first.rev as number) - 600_000_000,
    });
    expect(old).toMatchObject({ ok: true, items: [{ id: board.t1 }], total: 1, cursor: null });
    expect(old).not.toHaveProperty("resumed");
  });

  it("answers a page when the scope changed while nobody here subscribed to it", async () => {
    const { app } = await start();
    const { connection } = await connect(app, as(board.ada));
    const first = await colSub(connection, "byProject", board.p1);
    await colUnsub(connection, "byProject", board.p1);
    await write(app, (db) =>
      db.task.update({ where: { id: board.t1 }, data: { title: "Unseen" } }),
    );
    expect(
      await colSub(connection, "byProject", board.p1, { since: first.rev as number }),
    ).toMatchObject({ ok: true, items: [{ id: board.t1, title: "Unseen" }] });
  });

  it("answers a page when this process may not see every write: the change log off", async () => {
    const { app } = await start({ changeLog: false });
    const { connection } = await connect(app, as(board.ada));
    const first = await colSub(connection, "byProject", board.p1);
    const again = await colSub(connection, "byProject", board.p1, { since: first.rev as number });
    expect(again).toMatchObject({ ok: true, items: [{ id: board.t1 }] });
    expect(again).not.toHaveProperty("resumed");
  });

  it("gives a page read right after a reset a revision a client can resume from", async () => {
    const { app } = await start();
    const { connection } = await connect(app, as(board.ada));
    app.server.dispatcher.collections.reset(taskContract, "byProject", board.p1);
    const page = await colSub(connection, "byProject", board.p1);
    // Behind a cluster adapter a resume reads a page: a process's buffer sees its own flushes only.
    expect(
      await colSub(connection, "byProject", board.p1, { since: page.rev as number }),
    ).toMatchObject(
      inCluster()
        ? { ok: true, items: [{ id: board.t1 }] }
        : { ok: true, resumed: true, deltas: [] },
    );
  });
});

describe("revocation", () => {
  it("takes a removed member's socket out of the scope, and says so", async () => {
    const { app } = await start();
    const member = await connect(app, as(board.cy));
    const owner = await connect(app, as(board.ada));
    await colSub(member.connection, "byProject", board.p1);
    await colSub(owner.connection, "byProject", board.p1);
    await app
      .as(as(board.ada))
      .projectService.removeMember({ projectId: board.p1, userId: board.cy });
    await member.scopes.settle();
    expect(member.scopes.revoked).toEqual([
      { kind: "collection", reason: "access", s: "taskService", c: "byProject", scope: board.p1 },
    ]);
    expect(inRoom(app, "byProject", board.p1)).toBe(1);
    await write(app, (db) => db.task.update({ where: { id: board.t1 }, data: { title: "After" } }));
    await Promise.all([member.scopes.settle(), owner.scopes.settle()]);
    expect(member.scopes.frames).toEqual([]);
    expect(owner.scopes.frames).toHaveLength(1);
  });

  it("keeps a member whose new level still reaches the collection's", async () => {
    const { app } = await start();
    const member = await connect(app, as(board.bo));
    await colSub(member.connection, "byProject", board.p1);
    await app
      .as(as(board.ada))
      .projectService.setRole({ projectId: board.p1, userId: board.bo, role: "Read" });
    await member.scopes.settle();
    expect(member.scopes.revoked).toEqual([]);
    expect(inRoom(app, "byProject", board.p1)).toBe(1);
  });

  it("revokes a scope a lost service-wide Admin grant held, through access.refresh", async () => {
    const { app } = await start({ loadServiceAccess: () => ({}) });
    const admin = await connect(app, as(board.ed, { taskService: "Admin" }));
    expect(await colSub(admin.connection, "byProject", board.p1)).toMatchObject({ ok: true });
    await app.server.access.refresh(board.ed);
    await admin.scopes.settle();
    expect(admin.scopes.revoked).toEqual([
      { kind: "collection", reason: "access", s: "taskService", c: "byProject", scope: board.p1 },
    ]);
    expect(inRoom(app, "byProject", board.p1)).toBe(0);
  });

  it("closes every scope keyed by a deleted anchor row, and sends nothing more to them", async () => {
    const { app } = await start();
    const owner = await connect(app, as(board.ada));
    const member = await connect(app, as(board.cy));
    await colSub(owner.connection, "byProject", board.p1);
    await colSub(owner.connection, "openByProject", board.p1);
    await colSub(member.connection, "byProject", board.p1);
    await write(app, (db) => db.project.delete({ where: { id: board.p1 } }));
    await Promise.all([owner.scopes.settle(), member.scopes.settle()]);
    const closed = (c: string) => ({
      kind: "collection",
      reason: "anchor-deleted",
      s: "taskService",
      c,
      scope: board.p1,
    });
    expect(owner.scopes.revoked).toEqual([closed("byProject"), closed("openByProject")]);
    expect(member.scopes.revoked).toEqual([closed("byProject")]);
    expect(inRoom(app, "byProject", board.p1) + inRoom(app, "openByProject", board.p1)).toBe(0);
    app.server.dispatcher.collections.reset(taskContract, "byProject", board.p1);
    await Promise.all([owner.scopes.settle(), member.scopes.settle()]);
    expect([...owner.scopes.frames, ...member.scopes.frames]).toEqual([]);
  });
});

describe("races with a subscribe", () => {
  /** Holds the subscribe's page read until `during` has run. */
  function holdPageRead(during: () => Promise<unknown>) {
    let armed = true;
    return (read: Read): Promise<void> | undefined => {
      if (!armed || !isPageRead(read)) {
        return undefined;
      }
      armed = false;
      return during().then(() => undefined);
    };
  }

  it("authorizes again when access changed while it ran, so the socket never keeps the room", async () => {
    let appRef: App | undefined;
    const { app } = await start({
      after: holdPageRead(
        async () =>
          await appRef
            ?.as(as(board.ada))
            .projectService.removeMember({ projectId: board.p1, userId: board.cy }),
      ),
    });
    appRef = app;
    const member = await connect(app, as(board.cy));
    expect(await colSub(member.connection, "byProject", board.p1)).toEqual(forbidden);
    expect(inRoom(app, "byProject", board.p1)).toBe(0);
  });

  it("authorizes again with the grants the socket holds then: a grant lowered while it ran denies (LIVE-1)", async () => {
    let appRef: App | undefined;
    const { app } = await start({
      after: holdPageRead(async () => await appRef?.server.access.refresh(board.ed)),
      loadServiceAccess: () => ({}),
    });
    appRef = app;
    // Only the service-wide Admin grant lets ed open P1's scope.
    const admin = await connect(app, as(board.ed, { taskService: "Admin" }));
    expect(await colSub(admin.connection, "byProject", board.p1)).toEqual(forbidden);
    expect(inRoom(app, "byProject", board.p1)).toBe(0);
  });

  it("reads a self scope's page again when access changed while it ran", async () => {
    await h.prisma.task.update({ where: { id: board.t1 }, data: { assigneeId: board.cy } });
    // cy reads P2 too, so the page read again is a read, not a filter that matches nothing.
    await h.prisma.project.update({
      where: { id: board.p2 },
      data: { acl: [{ userId: board.cy, level: "Read" }] },
    });
    let appRef: App | undefined;
    const { app, reads } = await start({
      after: holdPageRead(
        async () =>
          await appRef
            ?.as(as(board.ada))
            .projectService.removeMember({ projectId: board.p1, userId: board.cy }),
      ),
    });
    appRef = app;
    const member = await connect(app, as(board.cy));
    expect(await colSub(member.connection, "mine", board.cy)).toMatchObject({
      ok: true,
      items: [],
    });
    expect(reads.filter(isPageRead)).toHaveLength(2);
  });

  it("filters a self scope's page read again for the grants the socket holds then (LIVE-1)", async () => {
    // ed reads T1 (in P1) only through the service-wide Admin grant; T2 is in P2, ed's own.
    await h.prisma.task.updateMany({
      where: { id: { in: [board.t1, board.t2] } },
      data: { assigneeId: board.ed },
    });
    let appRef: App | undefined;
    const { app, reads } = await start({
      after: holdPageRead(async () => await appRef?.server.access.refresh(board.ed)),
      loadServiceAccess: () => ({}),
    });
    appRef = app;
    const admin = await connect(app, as(board.ed, { taskService: "Admin" }));
    const reply = await colSub(admin.connection, "mine", board.ed);
    expect(reads.filter(isPageRead)).toHaveLength(2);
    expect(reply).toMatchObject({ ok: true, items: [{ id: board.t2 }] });
    expect((reply as { items: readonly unknown[] }).items).toHaveLength(1);
  });

  it("reads the page again when a flush changed the scope after its revision", async () => {
    let appRef: App | undefined;
    const { app, reads } = await start({
      after: holdPageRead(async () =>
        appRef === undefined
          ? undefined
          : await write(appRef, (db) =>
              db.task.update({ where: { id: board.t1 }, data: { title: "Raced" } }),
            ),
      ),
    });
    appRef = app;
    const owner = await connect(app, as(board.ada));
    expect(await colSub(owner.connection, "byProject", board.p1)).toMatchObject({
      items: [{ id: board.t1, title: "Raced" }],
    });
    expect(reads.filter(isPageRead)).toHaveLength(2);
  });

  it("answers FORBIDDEN for a scope revoked while its page was read again, never that page", async () => {
    let appRef: App | undefined;
    let pageReads = 0;
    let flushing = false;
    const during = async (step: (app: App) => Promise<unknown>) => {
      flushing = true;
      await (appRef === undefined ? undefined : step(appRef));
      flushing = false;
    };
    const { app } = await start({
      // After the first page, a flush changes the scope: the page is read again.
      after: (read) =>
        !flushing && isPageRead(read) && pageReads === 1
          ? during((target) =>
              write(target, (db) =>
                db.task.update({ where: { id: board.t1 }, data: { title: "Raced" } }),
              ),
            )
          : undefined,
      // Before that second read, the reader loses access to the scope.
      before: (read) => {
        if (flushing || !isPageRead(read)) {
          return undefined;
        }
        pageReads += 1;
        return pageReads === 2
          ? during((target) =>
              target
                .as(as(board.ada))
                .projectService.removeMember({ projectId: board.p1, userId: board.cy }),
            )
          : undefined;
      },
    });
    appRef = app;
    const member = await connect(app, as(board.cy));
    expect(await colSub(member.connection, "byProject", board.p1)).toEqual(forbidden);
    expect(pageReads).toBe(2);
    expect(inRoom(app, "byProject", board.p1)).toBe(0);
  });

  it("does not join a scope the client unsubscribed from while it ran", async () => {
    let unsubscribe: (() => Promise<unknown>) | undefined;
    const { app } = await start({ after: holdPageRead(async () => await unsubscribe?.()) });
    const owner = await connect(app, as(board.ada));
    unsubscribe = () => colUnsub(owner.connection, "byProject", board.p1);
    expect(await colSub(owner.connection, "byProject", board.p1)).toMatchObject({ ok: true });
    expect(inRoom(app, "byProject", board.p1)).toBe(0);
  });
});

describe("behind a cluster adapter", () => {
  it("reads a flush's rows without local subscribers, and answers resumes with a page", async () => {
    const { app, reads } = await start({ adapter: peeredCluster().adapter });
    reads.length = 0;
    await write(app, (db) => db.task.update({ where: { id: board.t1 }, data: { title: "Far" } }));
    // The two via collections' links (byLabel, taggedByLabel): only the collection sink reads them.
    expect(reads.filter((read) => read.model === "taskLabel")).toHaveLength(2);
    expect(itemReads(reads).length).toBeGreaterThan(0);
    const { connection } = await connect(app, as(board.ada));
    const first = await colSub(connection, "byProject", board.p1);
    const again = await colSub(connection, "byProject", board.p1, { since: first.rev as number });
    expect(again).toMatchObject({ ok: true, items: [{ id: board.t1 }] });
    expect(again).not.toHaveProperty("resumed");
  });
});

describe("the socket rate limiter", () => {
  it("does not count qd:col:sub and qd:col:unsub", async () => {
    const { app } = await start({ rateLimit: { maxRequests: 2 } });
    const { connection } = await connect(app, as(board.ada));
    for (let round = 0; round < 5; round += 1) {
      expect(await colSub(connection, "byProject", board.p1)).toMatchObject({ ok: true });
      expect(await colUnsub(connection, "byProject", board.p1)).toEqual({ ok: true });
    }
    const call = (id: number) =>
      emitWithAck(connection.socket, "qd:call", {
        id,
        s: "taskService",
        m: "get",
        i: { id: board.t1 },
      });
    expect(await call(1)).toMatchObject({ ok: true });
    expect(await call(2)).toMatchObject({ ok: true });
    expect(await call(3)).toMatchObject({ ok: false, e: { code: "RATE_LIMITED" } });
  });
});

describe("the per-socket cap (COLL-4)", () => {
  it(`holds at most ${MAX_SCOPES_PER_SOCKET} collection scopes per socket`, async () => {
    const { app } = await start();
    // A service-wide Admin opens any scope without a read.
    const { connection } = await connect(app, as(board.ed, { taskService: "Admin" }));
    const first = await colSub(connection, "byProject", board.p1);
    const since = first.rev as number;
    await colUnsub(connection, "byProject", board.p1);
    // In runs that fit the socket's lane (8 running, 64 waiting), which refuses more at once.
    const answers: Record<string, unknown>[] = [];
    for (let run = 0; run < MAX_SCOPES_PER_SOCKET; run += 50) {
      const batch = Array.from({ length: 50 }, (_, n) =>
        colSub(connection, "byProject", `cap-${run + n}`, { since }),
      );
      answers.push(...(await Promise.all(batch)));
    }
    expect(answers.every((answer) => answer.ok === true)).toBe(true);
    expect(await colSub(connection, "byProject", "one-more", { since })).toMatchObject({
      ok: false,
      e: { code: "CONFLICT" },
    });
    expect(inRoom(app, "byProject", "one-more")).toBe(0);
    const socket = app.server.io.sockets.sockets.get(connection.socket.id ?? "");
    expect(Object.keys(socket?.data.collections ?? {})).toHaveLength(MAX_SCOPES_PER_SOCKET);
    // One held already is no more; one unsubscribed makes room.
    expect(await colSub(connection, "byProject", "cap-0", { since })).toMatchObject({ ok: true });
    await colUnsub(connection, "byProject", "cap-0");
    expect(await colSub(connection, "byProject", "one-more", { since })).toMatchObject({
      ok: true,
    });
  }, 60_000);

  it("refuses at the join a scope subscribes running at once left no room for", async () => {
    const { app } = await start();
    const { connection } = await connect(app, as(board.ed, { taskService: "Admin" }));
    // 999 in runs of 37, which fit the socket's lane (8 running, 64 waiting).
    for (let run = 0; run < MAX_SCOPES_PER_SOCKET - 1; run += 37) {
      const batch = Array.from({ length: 37 }, (_, n) =>
        colSub(connection, "byProject", `cap-${run + n}`),
      );
      expect((await Promise.all(batch)).every((answer) => answer.ok === true)).toBe(true);
    }
    // Both pass the check before their reads: the first is held at its page read
    // while the second takes the last scope.
    const pause = pauseNext(h.database, /^\s*SELECT\b[\s\S]*FROM\s+"public"\."Task"/iu);
    try {
      const first = colSub(connection, "byProject", "first");
      await pause.reached;
      expect(await colSub(connection, "byProject", "second")).toMatchObject({ ok: true });
      pause.release();
      expect(await first).toMatchObject({ ok: false, e: { code: "CONFLICT" } });
    } finally {
      pause.restore();
    }
    expect(inRoom(app, "byProject", "first")).toBe(0);
    const socket = app.server.io.sockets.sockets.get(connection.socket.id ?? "");
    expect(Object.keys(socket?.data.collections ?? {})).toHaveLength(MAX_SCOPES_PER_SOCKET);
  }, 60_000);
});
