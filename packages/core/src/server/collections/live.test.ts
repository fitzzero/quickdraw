// Collections over time (RFC 0003 sections 4.4 and 7.3) through a real
// server against PGlite: resuming a scope from a revision, revocation when
// access changes or the anchor row is deleted, races between a subscribe and
// a flush or an access change, a cluster adapter, and the rate limiter.

import { Server, type Namespace } from "socket.io";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../../test/prisma/setup";
import { collectionRoom } from "../../index";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, emitWithAck, type TestApp } from "../../testing/index";
import { as, seedBoard, type Board } from "../access/__tests__/board";
import { projectService, recordingStorage, type Read } from "../emit/__tests__/live";
import type { Principal, QuickdrawIo, ServiceGrants } from "../index";
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
    expect(resumed.rev as number).toBeGreaterThan(first.rev as number);
    expect(itemReads(reads)).toEqual([]);
    expect(inRoom(app, "byProject", board.p1)).toBe(2);
    await write(app, (db) => db.task.update({ where: { id: board.t1 }, data: { title: "Live" } }));
    await away.scopes.settle();
    expect(away.scopes.frames).toEqual([
      expect.objectContaining({ deltas: [{ t: "patched", id: board.t1, d: { title: "Live" } }] }),
    ]);
  });

  it("resumes an unchanged scope with no deltas", async () => {
    const { app } = await start();
    const { connection } = await connect(app, as(board.ada));
    const first = await colSub(connection, "byProject", board.p1);
    expect(await colSub(connection, "byProject", board.p1, { since: first.rev as number })).toEqual(
      {
        ok: true,
        resumed: true,
        rev: first.rev,
        deltas: [],
      },
    );
  });

  it("answers a page when the buffer no longer covers the revision", async () => {
    const { app } = await start();
    const { connection } = await connect(app, as(board.ada));
    const first = await colSub(connection, "byProject", board.p1);
    const old = await colSub(connection, "byProject", board.p1, {
      since: (first.rev as number) - 600_000,
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
    expect(
      await colSub(connection, "byProject", board.p1, { since: page.rev as number }),
    ).toMatchObject({ ok: true, resumed: true, deltas: [] });
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

/** A Socket.IO adapter that hands `serverSideEmit` to the other servers it was made for: a cluster in one process. */
function peeredCluster() {
  const servers: QuickdrawIo[] = [];
  // A server attached to nothing holds no resources; it only shows the default adapter class.
  const Base = new Server().of("/").adapter.constructor as new (
    nsp: Namespace,
  ) => Namespace["adapter"];
  class PeeredAdapter extends Base {
    override serverSideEmit(packet: unknown[]): void {
      for (const io of servers) {
        if (io.sockets !== this.nsp) {
          (io.sockets as unknown as { _onServerSideEmit(args: unknown[]): void })._onServerSideEmit(
            packet,
          );
        }
      }
    }
  }
  return { adapter: PeeredAdapter as unknown as NonNullable<StartOptions["adapter"]>, servers };
}

describe("behind a cluster adapter", () => {
  it("reads a flush's rows without local subscribers, and answers resumes with a page", async () => {
    const { app, reads } = await start({ adapter: peeredCluster().adapter });
    reads.length = 0;
    await write(app, (db) => db.task.update({ where: { id: board.t1 }, data: { title: "Far" } }));
    // The via collection's links: only the collection sink reads them.
    expect(reads.filter((read) => read.model === "taskLabel")).toHaveLength(1);
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
