// Revocation (RFC 0003 section 4.4) through a real server against PGlite: an
// access change re-resolves the subscriptions anchored on the changed row,
// removing or moving sockets and telling them; races between a subscribe
// batch and a flush; several nodes behind a cluster adapter; and the rate
// limiter leaving subscriptions alone.

import { Server, type Namespace } from "socket.io";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { entityRoom } from "../../index";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, emitWithAck, type TestApp } from "../../testing/index";
import { deferred, type Deferred } from "../__tests__/fixtures";
import { as, seedBoard, type Board } from "../access/__tests__/board";
import type { Principal, QuickdrawIo, ServiceGrants } from "../index";
import {
  cardService,
  defineTaskService,
  isTaskRowRead,
  projectService,
  receive,
  recordingStorage,
  sub,
  type Read,
} from "./__tests__/live";

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
  /** A Socket.IO adapter: a cluster adapter for the multi-node tests. */
  readonly adapter?: NonNullable<ConstructorParameters<typeof Server>[1]>["adapter"];
  readonly loadServiceAccess?: (userId: string) => ServiceGrants | Promise<ServiceGrants>;
  /** Refresh a user's grants when their stored grants are written. */
  readonly grantsColumn?: boolean;
  readonly rateLimit?: { readonly maxRequests: number };
  /** Keep policy lookups across requests this long. */
  readonly cacheMs?: number;
}

async function start(options: StartOptions = {}) {
  const recorded = recordingStorage(h.storage, options.after, options.before);
  const app = await createTestApp({
    services: [projectService, defineTaskService(), cardService],
    db: h.db,
    storage: recorded.storage,
    ...(options.cacheMs === undefined ? {} : { access: { cacheMs: options.cacheMs } }),
    ...(options.adapter === undefined ? {} : { socket: { adapter: options.adapter } }),
    ...(options.loadServiceAccess === undefined
      ? {}
      : {
          auth: {
            loadServiceAccess: options.loadServiceAccess,
            ...(options.grantsColumn === true
              ? { serviceAccessSource: { model: "user", column: "serviceAccess" } }
              : {}),
          },
        }),
    ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
  });
  apps.push(app as unknown as TestApp);
  return { app, reads: recorded.reads };
}

type App = Awaited<ReturnType<typeof start>>["app"];

async function connect(app: App, principal: Principal) {
  const connection = await app.connect(principal);
  return { connection, frames: receive(connection) };
}

function roomsOf(app: App, service: string, id: string): string[] {
  const levels = ["Read", "Moderate", "Admin"] as const;
  return levels
    .map((level) => entityRoom(service, id, level))
    .filter((room) => (app.server.io.sockets.adapter.rooms.get(room)?.size ?? 0) > 0);
}

describe("an access change", () => {
  it("takes a removed member's socket out of the rooms anchored on the membership, and says so", async () => {
    const { app } = await start();
    const member = await connect(app, as(board.bo));
    const reader = await connect(app, as(board.cy));
    await sub(member.connection, "taskService", [board.t1]);
    await sub(member.connection, "projectService", [board.p1]);
    await sub(reader.connection, "taskService", [board.t1]);
    expect(
      await app
        .as(as(board.ada))
        .projectService.removeMember({ projectId: board.p1, userId: board.bo }),
    ).toBe(1);
    await member.frames.settle();
    expect(member.frames.revoked).toEqual(
      expect.arrayContaining([
        { kind: "entity", reason: "access", s: "taskService", id: board.t1 },
        { kind: "entity", reason: "access", s: "projectService", id: board.p1 },
      ]),
    );
    expect(member.frames.revoked).toHaveLength(2);
    expect(member.connection.socket.id).toBeDefined();
    expect(roomsOf(app, "taskService", board.t1)).toEqual([
      entityRoom("taskService", board.t1, "Read"),
    ]);
    await app.as(as(board.ada)).taskService.rename({ id: board.t1, title: "After" });
    await Promise.all([member.frames.settle(), reader.frames.settle()]);
    expect(member.frames.entity).toEqual([]);
    expect(reader.frames.entity).toEqual([
      expect.objectContaining({ t: "p", d: { title: "After" } }),
    ]);
    expect(reader.frames.revoked).toEqual([]);
  });

  it("moves a socket whose level changed to that level's room, and sends the row as it may now see it", async () => {
    const { app } = await start();
    await h.prisma.task.update({ where: { id: board.t1 }, data: { notes: "secret" } });
    const member = await connect(app, as(board.bo));
    await sub(member.connection, "taskService", [board.t1]);
    expect(roomsOf(app, "taskService", board.t1)).toEqual([
      entityRoom("taskService", board.t1, "Moderate"),
    ]);
    await app
      .as(as(board.ada))
      .projectService.setRole({ projectId: board.p1, userId: board.bo, role: "Admin" });
    await member.frames.settle();
    expect(roomsOf(app, "taskService", board.t1)).toEqual([
      entityRoom("taskService", board.t1, "Admin"),
    ]);
    expect(member.frames.entity).toEqual([
      expect.objectContaining({
        t: "u",
        id: board.t1,
        d: expect.objectContaining({ notes: "secret" }),
      }),
    ]);
    member.frames.clear();
    await app
      .as(as(board.ada))
      .projectService.setRole({ projectId: board.p1, userId: board.bo, role: "Read" });
    await member.frames.settle();
    expect(roomsOf(app, "taskService", board.t1)).toEqual([
      entityRoom("taskService", board.t1, "Read"),
    ]);
    expect(member.frames.entity).toEqual([expect.objectContaining({ t: "u", id: board.t1 })]);
    expect(member.frames.entity[0]).not.toHaveProperty("d.notes");
    expect(member.frames.revoked).toEqual([]);
  });

  it("sends a deleted row's subscribers its removal, not a revocation", async () => {
    const { app } = await start();
    const owner = await connect(app, as(board.ada));
    await sub(owner.connection, "taskService", [board.t1]);
    await app.as(as(board.ada)).taskService.remove({ id: board.t1 });
    await owner.frames.settle();
    expect(owner.frames.entity).toEqual([
      { t: "r", s: "taskService", id: board.t1, rev: expect.any(Number) },
    ]);
    expect(owner.frames.revoked).toEqual([]);
  });

  it("revokes a subscription a lost service-wide Admin grant held, through access.refresh", async () => {
    const { app } = await start({ loadServiceAccess: () => ({}) });
    const admin = await connect(app, as(board.di, { taskService: "Admin" }));
    expect(await sub(admin.connection, "taskService", [board.t2])).toMatchObject({
      r: [{ ok: true, d: { id: board.t2 } }],
    });
    const access = new Promise((resolve) => {
      admin.connection.socket.once("qd:access", resolve);
    });
    expect(await app.server.access.refresh(board.di)).toEqual({});
    expect(await access).toEqual({ serviceAccess: {} });
    await admin.frames.settle();
    expect(admin.frames.revoked).toEqual([
      { kind: "entity", reason: "access", s: "taskService", id: board.t2 },
    ]);
    expect(roomsOf(app, "taskService", board.t2)).toEqual([]);
  });
});

describe("a row created again with a deleted row's id", () => {
  const removed = (id: string) => ({ t: "r", s: "taskService", id, rev: expect.any(Number) });
  const revoked = (id: string) => ({ kind: "entity", reason: "access", s: "taskService", id });

  it("authorizes the deleted row's subscribers again, revoking one that may not read it before its first frame", async () => {
    const { app } = await start();
    const reader = await connect(app, as(board.cy));
    await sub(reader.connection, "taskService", [board.t1]);
    await app.server.dispatcher.run(() => h.db.task.delete({ where: { id: board.t1 } }));
    await reader.frames.settle();
    // A deleted row's subscribers keep its room: they get its removal, not a revocation.
    expect(reader.frames.entity).toEqual([removed(board.t1)]);
    expect(reader.frames.revoked).toEqual([]);
    reader.frames.clear();
    await app.server.dispatcher.run(() =>
      h.db.task.create({ data: { id: board.t1, projectId: board.p2, title: "P2 secret" } }),
    );
    await reader.frames.settle();
    expect(reader.frames.entity).toEqual([]);
    expect(reader.frames.revoked).toEqual([revoked(board.t1)]);
    expect(roomsOf(app, "taskService", board.t1)).toEqual([]);
  });

  it("keeps a subscriber that may read the new row, and sends it the row whole", async () => {
    const { app } = await start();
    const reader = await connect(app, as(board.cy));
    await sub(reader.connection, "taskService", [board.t1]);
    await app.server.dispatcher.run(() => h.db.task.delete({ where: { id: board.t1 } }));
    await app.server.dispatcher.run(() =>
      h.db.task.create({ data: { id: board.t1, projectId: board.p1, title: "Back" } }),
    );
    await reader.frames.settle();
    expect(reader.frames.entity).toEqual([
      removed(board.t1),
      expect.objectContaining({
        t: "u",
        id: board.t1,
        d: expect.objectContaining({ title: "Back" }),
      }),
    ]);
    expect(reader.frames.revoked).toEqual([]);
  });

  it("authorizes again when one unit deleted the row and created it elsewhere", async () => {
    const { app } = await start();
    const reader = await connect(app, as(board.cy));
    const owner = await connect(app, as(board.ed));
    await sub(reader.connection, "taskService", [board.t1]);
    await app.server.dispatcher.run(async () => {
      const old = await h.db.task.delete({ where: { id: board.t1 } });
      await h.db.task.create({ data: { id: old.id, projectId: board.p2, title: "Now in P2" } });
    });
    await reader.frames.settle();
    expect(reader.frames.entity).toEqual([]);
    expect(reader.frames.revoked).toEqual([revoked(board.t1)]);
    // The new project's owner may subscribe to it.
    expect(await sub(owner.connection, "taskService", [board.t1])).toMatchObject({
      r: [{ ok: true, d: { projectId: board.p2, title: "Now in P2" } }],
    });
  });
});

describe("stored grants", () => {
  it("refreshes a user whose stored grants a tracked write changed, revoking what a lost grant held", async () => {
    const { app } = await start({
      grantsColumn: true,
      loadServiceAccess: async (userId) => {
        const user = await h.prisma.user.findUniqueOrThrow({ where: { id: userId } });
        return (user.serviceAccess ?? {}) as ServiceGrants;
      },
    });
    const admin = await connect(app, as(board.di, { taskService: "Admin" }));
    await sub(admin.connection, "taskService", [board.t2]);
    const access = new Promise((resolve) => {
      admin.connection.socket.once("qd:access", resolve);
    });
    await app
      .as(as(board.ada))
      .projectService.setGrants({ userId: board.di, grants: { taskService: "Read" } });
    expect(await access).toEqual({ serviceAccess: { taskService: "Read" } });
    await admin.frames.settle();
    expect(admin.frames.revoked).toEqual([
      { kind: "entity", reason: "access", s: "taskService", id: board.t2 },
    ]);
  });

  it("needs loadServiceAccess to reload what it stores", async () => {
    await expect(
      createTestApp({
        services: [projectService],
        db: h.db,
        auth: { serviceAccessSource: { model: "user", column: "serviceAccess" } },
      }),
    ).rejects.toThrow(
      "createServer: auth.serviceAccessSource needs auth.loadServiceAccess to reload the grants it stores",
    );
  });
});

describe("races with a subscribe batch", () => {
  /** Holds the batch's row read until `release`, after `during` has run. */
  function holdRowRead(during: () => Promise<unknown>): {
    readonly after: (read: Read) => Promise<void> | undefined;
    readonly held: Deferred<void>;
  } {
    const held = deferred();
    let armed = true;
    return {
      held,
      after: (read) => {
        if (!armed || !isTaskRowRead(read)) {
          return undefined;
        }
        armed = false;
        return during().then(() => held.resolve());
      },
    };
  }

  it("re-checks access that changed while the batch ran, so the socket never keeps the room", async () => {
    let appRef: App | undefined;
    const hold = holdRowRead(
      async () =>
        await appRef
          ?.as(as(board.ada))
          .projectService.removeMember({ projectId: board.p1, userId: board.cy }),
    );
    const { app } = await start({ after: hold.after });
    appRef = app;
    const reader = await connect(app, as(board.cy));
    expect(await sub(reader.connection, "taskService", [board.t1])).toEqual({
      ok: true,
      r: [{ ok: false, e: { code: "FORBIDDEN", message: "Insufficient permissions" } }],
    });
    expect(roomsOf(app, "taskService", board.t1)).toEqual([]);
  });

  it("reads a row again when a flush touched it after the batch's revision", async () => {
    let appRef: App | undefined;
    const hold = holdRowRead(
      async () =>
        await appRef?.as(as(board.ada)).taskService.rename({ id: board.t1, title: "Raced" }),
    );
    const { app, reads } = await start({ after: hold.after });
    appRef = app;
    const owner = await connect(app, as(board.ada));
    const reply = (await sub(owner.connection, "taskService", [board.t1])) as {
      r: [{ d: { title: string }; rev: number }];
    };
    await owner.frames.settle();
    // The first read saw "T1"; its frame went out before the join; the second read sees the rename.
    expect(reply.r[0].d.title).toBe("Raced");
    expect(reads.filter(isTaskRowRead)).toHaveLength(2);
    expect(owner.frames.entity).toEqual([]);
  });

  it("answers FORBIDDEN for a row revoked while the batch read it again, never the row it read", async () => {
    let appRef: App | undefined;
    let rowReads = 0;
    const flush = async (data: { projectId?: string; title?: string; status?: string }) => {
      await appRef?.server.dispatcher.run(() =>
        h.db.task.update({ where: { id: board.t1 }, data }),
      );
    };
    // Counts the batch's own row reads only: the flushes below read rows too.
    let flushing = false;
    const during = async (step: () => Promise<void>) => {
      flushing = true;
      await step();
      flushing = false;
    };
    const { app } = await start({
      // After the first read, a flush touches the row: the batch reads it again.
      after: (read) =>
        !flushing && isTaskRowRead(read) && rowReads === 1
          ? during(() => flush({ status: "touched" }))
          : undefined,
      // Before that second read, the row moves to a project the reader cannot read.
      before: (read) => {
        if (flushing || !isTaskRowRead(read)) {
          return undefined;
        }
        rowReads += 1;
        return rowReads === 2
          ? during(() => flush({ projectId: board.p2, title: "Moved to P2" }))
          : undefined;
      },
    });
    appRef = app;
    const reader = await connect(app, as(board.cy));
    expect(await sub(reader.connection, "taskService", [board.t1])).toEqual({
      ok: true,
      r: [{ ok: false, e: { code: "FORBIDDEN", message: "Insufficient permissions" } }],
    });
    await reader.frames.settle();
    expect(rowReads).toBe(2);
    expect(reader.frames.entity).toEqual([]);
    expect(roomsOf(app, "taskService", board.t1)).toEqual([]);
  });

  it("checks access again at most three times after its reads, keeping rows whose anchors held still", async () => {
    let appRef: App | undefined;
    let memberReads = 0;
    let flushing = false;
    // Every lookup of the reader's membership sees another access change elsewhere (P2's list).
    const { app } = await start({
      after: async (read) => {
        if (flushing || read.model !== "projectMember" || appRef === undefined) {
          return;
        }
        memberReads += 1;
        flushing = true;
        await appRef.server.dispatcher.run(() =>
          h.db.project.update({ where: { id: board.p2 }, data: { acl: [] } }),
        );
        flushing = false;
      },
    });
    appRef = app;
    const reader = await connect(app, as(board.cy));
    expect(await sub(reader.connection, "taskService", [board.t1])).toMatchObject({
      r: [{ ok: true, d: { id: board.t1 } }],
    });
    // The first lookup, the check after the join, then three more while access kept changing.
    expect(memberReads).toBe(5);
    expect(roomsOf(app, "taskService", board.t1)).toEqual([
      entityRoom("taskService", board.t1, "Read"),
    ]);
  });

  it("keeps no socket that disconnected while access was checked again in the index", async () => {
    let appRef: App | undefined;
    let memberReads = 0;
    let flushing = false;
    const { app, reads } = await start({
      after: async (read) => {
        if (flushing || read.model !== "projectMember" || appRef === undefined) {
          return;
        }
        memberReads += 1;
        if (memberReads === 1) {
          // While the batch resolves access: an unrelated access change, so it checks again.
          flushing = true;
          await appRef.server.dispatcher.run(() =>
            h.db.project.update({ where: { id: board.p2 }, data: { acl: [] } }),
          );
          flushing = false;
        } else if (memberReads === 2) {
          // While it checks again, the client goes away.
          [...appRef.server.io.sockets.sockets.values()][0]?.disconnect(true);
          await new Promise((resolve) => {
            setTimeout(resolve, 20);
          });
        }
      },
    });
    appRef = app;
    const member = await connect(app, as(board.bo));
    member.connection.socket.emit("qd:sub", { s: "taskService", ids: [board.t1] }, () => undefined);
    await expect.poll(() => memberReads).toBe(2);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(app.server.io.sockets.sockets.size).toBe(0);
    // An access change on the row's project finds no subscription to resolve again.
    flushing = true;
    reads.length = 0;
    await app.server.dispatcher.run(() =>
      h.db.project.update({ where: { id: board.p1 }, data: { acl: [] } }),
    );
    expect(reads).toEqual([]);
  });

  it("does not join again a row the client unsubscribed from while access was checked again", async () => {
    let appRef: App | undefined;
    let unsubscribe: (() => Promise<unknown>) | undefined;
    let memberReads = 0;
    let flushing = false;
    const { app } = await start({
      after: async (read) => {
        if (flushing || read.model !== "projectMember" || appRef === undefined) {
          return;
        }
        memberReads += 1;
        if (memberReads === 1) {
          flushing = true;
          await appRef.server.dispatcher.run(() =>
            h.db.project.update({ where: { id: board.p2 }, data: { acl: [] } }),
          );
          flushing = false;
        } else if (memberReads === 2) {
          await unsubscribe?.();
        }
      },
    });
    appRef = app;
    const member = await connect(app, as(board.bo));
    unsubscribe = () =>
      emitWithAck(member.connection.socket, "qd:unsub", { s: "taskService", ids: [board.t1] });
    expect(await sub(member.connection, "taskService", [board.t1])).toMatchObject({
      r: [{ ok: true, d: { id: board.t1 } }],
    });
    expect(memberReads).toBe(2);
    expect(roomsOf(app, "taskService", board.t1)).toEqual([]);
  });

  it("does not join a row the client unsubscribed from while the batch ran", async () => {
    let socketRef: { emitWithAck(event: string, payload: unknown): Promise<unknown> } | undefined;
    const hold = holdRowRead(
      async () => await socketRef?.emitWithAck("qd:unsub", { s: "taskService", ids: [board.t1] }),
    );
    const { app } = await start({ after: hold.after });
    const owner = await connect(app, as(board.ada));
    socketRef = owner.connection.socket;
    expect(await sub(owner.connection, "taskService", [board.t1])).toMatchObject({
      r: [{ ok: true, d: { id: board.t1 } }],
    });
    expect(roomsOf(app, "taskService", board.t1)).toEqual([]);
  });

  it("does not join for a socket that disconnected while the batch ran", async () => {
    let closeRef: (() => void) | undefined;
    const hold = holdRowRead(async () => {
      closeRef?.();
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    });
    const { app } = await start({ after: hold.after });
    const owner = await connect(app, as(board.ada));
    closeRef = () => owner.connection.close();
    const serverSocket = app.server.io.sockets.sockets.get(owner.connection.socket.id ?? "");
    owner.connection.socket.emit("qd:sub", { s: "taskService", ids: [board.t1] }, () => undefined);
    await hold.held.promise;
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(serverSocket?.connected).toBe(false);
    expect(roomsOf(app, "taskService", board.t1)).toEqual([]);
    expect(serverSocket?.data.entities ?? {}).toEqual({});
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
  it("reads touched rows without local subscribers, since other nodes' rooms are not visible", async () => {
    const cluster = peeredCluster();
    const { app, reads } = await start({ adapter: cluster.adapter });
    reads.length = 0;
    await app.as(as(board.ada)).taskService.rename({ id: board.t1, title: "Elsewhere" });
    expect(reads.filter(isTaskRowRead)).toHaveLength(2);
  });

  it("revokes on every node: an access change flushed on one reaches the sockets of another", async () => {
    const cluster = peeredCluster();
    const writer = await start({ adapter: cluster.adapter });
    const holder = await start({ adapter: cluster.adapter });
    cluster.servers.push(writer.app.server.io, holder.app.server.io);
    const member = await connect(holder.app, as(board.bo));
    await sub(member.connection, "taskService", [board.t1]);
    await writer.app
      .as(as(board.ada))
      .projectService.removeMember({ projectId: board.p1, userId: board.bo });
    await expect
      .poll(() => member.frames.revoked)
      .toEqual([{ kind: "entity", reason: "access", s: "taskService", id: board.t1 }]);
    expect(roomsOf(holder.app, "taskService", board.t1)).toEqual([]);
  });

  it("revokes on every node with cacheMs: a node forgets what another node's change names first", async () => {
    const cluster = peeredCluster();
    const writer = await start({ adapter: cluster.adapter, cacheMs: 60_000 });
    const holder = await start({ adapter: cluster.adapter, cacheMs: 60_000 });
    cluster.servers.push(writer.app.server.io, holder.app.server.io);
    const member = await connect(holder.app, as(board.bo));
    // The subscribe and this call leave the member's level in the holder's cache.
    await sub(member.connection, "taskService", [board.t1]);
    await expect(
      holder.app.as(as(board.bo)).taskService.get({ id: board.t1 }),
    ).resolves.toMatchObject({ id: board.t1 });
    await writer.app
      .as(as(board.ada))
      .projectService.removeMember({ projectId: board.p1, userId: board.bo });
    await expect
      .poll(() => member.frames.revoked)
      .toEqual([{ kind: "entity", reason: "access", s: "taskService", id: board.t1 }]);
    expect(roomsOf(holder.app, "taskService", board.t1)).toEqual([]);
    await expect(
      holder.app.as(as(board.bo)).taskService.get({ id: board.t1 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("revokes on every node when a row is created again: another node's log cannot tell it exists", async () => {
    const cluster = peeredCluster();
    const writer = await start({ adapter: cluster.adapter });
    const holder = await start({ adapter: cluster.adapter });
    cluster.servers.push(writer.app.server.io, holder.app.server.io);
    const reader = await connect(holder.app, as(board.cy));
    await sub(reader.connection, "taskService", [board.t1]);
    // The holder flushes the delete itself, so its own change log says the row is gone.
    await holder.app.server.dispatcher.run(() => h.db.task.delete({ where: { id: board.t1 } }));
    await writer.app.server.dispatcher.run(() =>
      h.db.task.create({ data: { id: board.t1, projectId: board.p2, title: "P2 secret" } }),
    );
    await expect
      .poll(() => reader.frames.revoked)
      .toEqual([{ kind: "entity", reason: "access", s: "taskService", id: board.t1 }]);
    expect(roomsOf(holder.app, "taskService", board.t1)).toEqual([]);
  });

  it("applies grants access.refresh reloaded on one node to the sockets of every node", async () => {
    const cluster = peeredCluster();
    const writer = await start({ adapter: cluster.adapter, loadServiceAccess: () => ({}) });
    const holder = await start({ adapter: cluster.adapter, loadServiceAccess: () => ({}) });
    cluster.servers.push(writer.app.server.io, holder.app.server.io);
    const admin = await connect(holder.app, as(board.di, { taskService: "Admin" }));
    await sub(admin.connection, "taskService", [board.t2]);
    await writer.app.server.access.refresh(board.di);
    await expect
      .poll(() => admin.frames.revoked)
      .toEqual([{ kind: "entity", reason: "access", s: "taskService", id: board.t2 }]);
    const socket = holder.app.server.io.sockets.sockets.get(admin.connection.socket.id ?? "");
    expect(socket?.data.principal?.serviceAccess).toEqual({});
  });
});

describe("the socket rate limiter", () => {
  it("does not count qd:sub and qd:unsub", async () => {
    const { app } = await start({ rateLimit: { maxRequests: 2 } });
    const { connection } = await connect(app, as(board.ada));
    for (let round = 0; round < 5; round += 1) {
      expect(await sub(connection, "taskService", [board.t1])).toMatchObject({ ok: true });
      expect(
        await emitWithAck(connection.socket, "qd:unsub", { s: "taskService", ids: [board.t1] }),
      ).toEqual({ ok: true });
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
