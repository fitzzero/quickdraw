// The live data against a real server on PGlite with tracked writes (RFC 0003
// sections 6, 7, 8.2 and 11.5), without React: real writes send the frames.
// This file runs under Node, so everything here also runs with `document`
// undefined, as in React Native.

import { renderToString } from "react-dom/server";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tick } from "../../server/__tests__/fixtures";
import { createQuickdrawClient } from "../createClient";
import { collectionKey, entityKey } from "../keys";
import { QuickdrawProvider } from "../provider";
import { outgoing, until } from "../__tests__/fixtures";
import { as, freshClient, liveDataHarness, taskContract } from "./__tests__/server";
import type { CollectionEntry, CollectionTarget } from "./collectionLoads";
import { loadedIds } from "./collectionStore";
import type { EntityEntry } from "./entities";
import { liveDataOf } from "./liveData";
import { showCollection, viewPredicate } from "./views";

const live = liveDataHarness();

function targetOf(collection: keyof typeof taskContract.collections): CollectionTarget {
  return { service: "taskService", collection, def: taskContract.collections[collection] };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** A connection as `userId`, its query client and live data, and the frames it sends from now on. */
async function client(url: string, userId: string) {
  const connection = await live.connect(url, as(userId));
  const queryClient = freshClient();
  return {
    connection,
    queryClient,
    data: liveDataOf(connection, queryClient),
    sent: outgoing(connection),
  };
}

type Client = Awaited<ReturnType<typeof client>>;

function entityOf(c: Client, id: string): EntityEntry<{ readonly title?: string }> | undefined {
  return c.queryClient.getQueryData(entityKey("taskService", id));
}

function scopeOf(c: Client, collection: string, scope: string): CollectionEntry | undefined {
  return c.queryClient.getQueryData(collectionKey("taskService", collection, scope));
}

function hasState(c: Client, collection: string, scope: string): boolean {
  const state = scopeOf(c, collection, scope)?.state;
  return state !== null && state !== undefined;
}

function framesOf(sent: readonly unknown[][], event: string): Record<string, unknown>[] {
  return sent
    .filter(([name]) => name === event)
    .map(([, frame]) => frame as Record<string, unknown>);
}

describe("live entities", () => {
  it("subscribes rows in one qd:sub, and applies p, u and r frames from real writes", async () => {
    const { app, write } = await live.start();
    const board = live.board();
    const ada = await client(app.url, board.ada);
    const release = ada.data.entities.subscribe("taskService", [board.t1]);
    await until(() => entityOf(ada, board.t1)?.data !== undefined);
    expect(entityOf(ada, board.t1)?.data?.title).toBe("T1");
    expect(framesOf(ada.sent, "qd:sub")).toEqual([{ s: "taskService", ids: [board.t1] }]);

    await write((db) => db.task.update({ where: { id: board.t1 }, data: { title: "Patched" } }));
    await until(() => entityOf(ada, board.t1)?.data?.title === "Patched");
    await write((db) => db.task.delete({ where: { id: board.t1 } }));
    await until(() => entityOf(ada, board.t1)?.removed === true);
    expect(entityOf(ada, board.t1)?.data).toBeUndefined();
    release();
    await until(() => framesOf(ada.sent, "qd:unsub").length === 1);
  });

  it("serves 500 rows from one qd:e listener and one qd:sub", async () => {
    const { app } = await live.start();
    const board = live.board();
    await live.prisma().task.createMany({
      data: Array.from({ length: 499 }, (_, index) => ({
        projectId: board.p1,
        title: `Task ${index}`,
      })),
    });
    const tasks = await live
      .prisma()
      .task.findMany({ where: { projectId: board.p1 }, select: { id: true } });
    const ids = tasks.map((task) => task.id);
    expect(ids).toHaveLength(500);
    const ada = await client(app.url, board.ada);
    ada.data.entities.subscribe("taskService", ids);
    await until(() => ids.every((id) => entityOf(ada, id)?.data !== undefined), 10_000);

    expect(ada.connection.socket.listeners("qd:e")).toHaveLength(1);
    expect(framesOf(ada.sent, "qd:sub")).toHaveLength(1);
    expect(framesOf(ada.sent, "qd:sub")[0]?.ids).toHaveLength(500);
  });

  it("after a reconnect, asks for each row with the revision held, and keeps an unchanged one", async () => {
    const { app } = await live.start();
    const board = live.board();
    const ada = await client(app.url, board.ada);
    ada.data.entities.subscribe("taskService", [board.t1]);
    await until(() => entityOf(ada, board.t1)?.data !== undefined);
    const loaded = entityOf(ada, board.t1);

    const first = ada.connection.socket.id;
    app.server.rotate({ withinMs: 0 });
    await until(() => framesOf(ada.sent, "qd:sub").length === 2);
    expect(ada.connection.socket.id).not.toBe(first);
    expect(framesOf(ada.sent, "qd:sub")[1]).toEqual({
      s: "taskService",
      ids: [board.t1],
      revs: [loaded?.rev],
    });
    await tick(100);
    // Not modified: the very same entry, data and revision.
    expect(entityOf(ada, board.t1)).toBe(loaded);
  });

  it("drops a row whose access is revoked, and shows FORBIDDEN", async () => {
    const { app } = await live.start();
    const board = live.board();
    const cy = await client(app.url, board.cy);
    cy.data.entities.subscribe("taskService", [board.t1]);
    await until(() => entityOf(cy, board.t1)?.data !== undefined);
    await app
      .as(as(board.ada))
      .projectService.removeMember({ projectId: board.p1, userId: board.cy });
    await until(() => entityOf(cy, board.t1)?.error?.code === "FORBIDDEN");
    expect(entityOf(cy, board.t1)?.data).toBeUndefined();
  });

  it("asks for a row again when a patch arrives and no row is held", async () => {
    const { app, write } = await live.start();
    const board = live.board();
    const ada = await client(app.url, board.ada);
    ada.data.entities.subscribe("taskService", [board.t1]);
    await until(() => entityOf(ada, board.t1)?.data !== undefined);
    ada.queryClient.removeQueries({ queryKey: entityKey("taskService", board.t1) });

    await write((db) => db.task.update({ where: { id: board.t1 }, data: { title: "After" } }));
    await until(() => entityOf(ada, board.t1)?.data?.title === "After");
    expect(framesOf(ada.sent, "qd:sub")).toHaveLength(2);
    expect(framesOf(ada.sent, "qd:sub")[1]).toEqual({ s: "taskService", ids: [board.t1] });
  });
});

describe("live collections", () => {
  it("loads the first page and the index, and keeps both current from real writes", async () => {
    const { app, write } = await live.start();
    const board = live.board();
    await live.prisma().task.createMany({
      data: [3, 1, 2].map((ordinal) => ({
        projectId: board.p1,
        title: `Task ${ordinal}`,
        ordinal,
      })),
    });
    const ada = await client(app.url, board.ada);
    ada.data.collections.subscribe(targetOf("board"), board.p1);
    await until(() => hasState(ada, "board", board.p1));
    const ordinals = (): unknown[] =>
      (scopeOf(ada, "board", board.p1)?.state?.index ?? []).map((member) => member.ordinal);
    expect(ordinals()).toEqual([0, 1, 2, 3]);

    const created = await write((db) =>
      db.task.create({ data: { projectId: board.p1, title: "New", ordinal: 2 } }),
    );
    await until(() => ordinals().length === 5);
    await write((db) => db.task.update({ where: { id: board.t1 }, data: { ordinal: 9 } }));
    await until(() => ordinals().at(-1) === 9);
    await write((db) => db.task.delete({ where: { id: created.id } }));
    await until(() => ordinals().length === 4);

    const state = scopeOf(ada, "board", board.p1)?.state;
    expect(ordinals()).toEqual([1, 2, 3, 9]);
    expect(state?.totalCount).toBe(4);
    expect(state?.byId.get(board.t1)).toMatchObject({ ordinal: 9 });
    expect(loadedIds(state ?? (undefined as never))).toHaveLength(4);
  });

  it("after a reconnect inside the server's buffer, requests no snapshot and applies the missed deltas in order", async () => {
    const { app, reads, write } = await live.start();
    const board = live.board();
    // Another subscriber keeps the scope's deltas buffered while the client is away.
    const watcher = await app.connect(as(board.ada));
    watcher.socket.emit(
      "qd:col:sub",
      { s: "taskService", c: "byProject", scope: board.p1 },
      () => undefined,
    );
    const ada = await client(app.url, board.ada);
    ada.data.collections.subscribe(targetOf("byProject"), board.p1);
    await until(() => hasState(ada, "byProject", board.p1));
    const held = scopeOf(ada, "byProject", board.p1)?.state?.rev;

    ada.connection.close();
    const created = await write((db) =>
      db.task.create({ data: { projectId: board.p1, title: "While away", ordinal: 3 } }),
    );
    await write((db) => db.task.update({ where: { id: board.t1 }, data: { title: "Renamed" } }));
    await write((db) => db.task.update({ where: { id: created.id }, data: { title: "Twice" } }));
    const pageReads = (): number => reads.filter((read) => read.args.take !== undefined).length;
    const before = pageReads();
    ada.connection.open();

    await until(() => scopeOf(ada, "byProject", board.p1)?.state?.byId.has(created.id) === true);
    const subs = framesOf(ada.sent, "qd:col:sub");
    expect(subs.at(-1)).toEqual({ s: "taskService", c: "byProject", scope: board.p1, since: held });
    const state = scopeOf(ada, "byProject", board.p1)?.state;
    expect(state?.byId.get(created.id)).toMatchObject({ title: "Twice" });
    expect(state?.byId.get(board.t1)).toMatchObject({ title: "Renamed" });
    expect(pageReads()).toBe(before);
  });

  it("updates a view over index fields as an item's index field changes", async () => {
    const { app, write } = await live.start();
    const board = live.board();
    const ada = await client(app.url, board.ada);
    ada.data.collections.subscribe(targetOf("board"), board.p1);
    await until(() => hasState(ada, "board", board.p1));
    const mine = viewPredicate(taskContract.collections.board, "mine");
    const inView = (userId: string): string[] => {
      const state = scopeOf(ada, "board", board.p1)?.state;
      return state === null || state === undefined
        ? []
        : (
            showCollection(state, { view: mine, who: { userId }, overlay: (row) => row }).index ??
            []
          ).map((member) => member.id);
    };
    expect(inView(board.ada)).toEqual([]);

    await write((db) =>
      db.task.update({ where: { id: board.t1 }, data: { assigneeId: board.ada } }),
    );
    await until(() => inView(board.ada).length === 1);
    expect(inView(board.bo)).toEqual([]);
    await write((db) =>
      db.task.update({ where: { id: board.t1 }, data: { assigneeId: board.bo } }),
    );
    await until(() => inView(board.ada).length === 0);
    expect(inView(board.bo)).toEqual([board.t1]);
  });

  it("with load all, loads every page and stops", async () => {
    const { app } = await live.start();
    const board = live.board();
    await live.prisma().task.createMany({
      data: Array.from({ length: 34 }, (_, index) => ({
        projectId: board.p1,
        title: `T${index}`,
        ordinal: index + 1,
      })),
    });
    const ada = await client(app.url, board.ada);
    ada.data.collections.subscribe(targetOf("board"), board.p1, { limit: 10, loadAll: true });
    await until(() => scopeOf(ada, "board", board.p1)?.state?.byId.size === 35);
    await tick(200);

    const state = scopeOf(ada, "board", board.p1)?.state;
    expect(state?.nextCursor).toBeNull();
    expect(framesOf(ada.sent, "qd:col:sub")).toHaveLength(4);
    expect(state?.index).toHaveLength(35);
  });

  it("loads the item of a patch it does not hold with qd:col:items, never a partial one", async () => {
    const { app, write } = await live.start();
    const board = live.board();
    await live.prisma().task.updateMany({ where: { projectId: board.p1 }, data: { ordinal: 0 } });
    const open = await live.prisma().task.createManyAndReturn({
      data: [1, 2, 3, 4].map((ordinal) => ({
        projectId: board.p1,
        title: `Open ${ordinal}`,
        ordinal,
      })),
    });
    const far = open[3]?.id ?? "";
    const ada = await client(app.url, board.ada);
    ada.data.collections.subscribe(targetOf("openByProject"), board.p1);
    await until(() => hasState(ada, "openByProject", board.p1));
    expect(scopeOf(ada, "openByProject", board.p1)?.state?.byId.size).toBe(2);

    await write((db) => db.task.update({ where: { id: far }, data: { title: "Far, patched" } }));
    await until(() => scopeOf(ada, "openByProject", board.p1)?.state?.byId.has(far) === true);
    expect(framesOf(ada.sent, "qd:col:items")).toEqual([
      { s: "taskService", c: "openByProject", scope: board.p1, ids: [far] },
    ]);
    expect(scopeOf(ada, "openByProject", board.p1)?.state?.byId.get(far)).toMatchObject({
      title: "Far, patched",
      ordinal: 4,
    });
  });

  it("reloads a reset scope after the random delay", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { app } = await live.start();
    const board = live.board();
    const ada = await client(app.url, board.ada);
    ada.data.collections.subscribe(targetOf("byProject"), board.p1);
    await until(() => hasState(ada, "byProject", board.p1));
    await live.prisma().task.create({ data: { projectId: board.p1, title: "Untracked" } });
    app.server.dispatcher.collections.reset(taskContract, "byProject", board.p1);
    await until(() => scopeOf(ada, "byProject", board.p1)?.state?.byId.size === 2);
    expect(framesOf(ada.sent, "qd:col:sub")).toHaveLength(2);
  });

  it("drops a scope when access to it is revoked, or when its anchor row is deleted", async () => {
    const { app, write } = await live.start();
    const board = live.board();
    const cy = await client(app.url, board.cy);
    const ed = await client(app.url, board.ed);
    cy.data.collections.subscribe(targetOf("byProject"), board.p1);
    ed.data.collections.subscribe(targetOf("byProject"), board.p2);
    await until(() => hasState(cy, "byProject", board.p1));
    await until(() => hasState(ed, "byProject", board.p2));

    await app
      .as(as(board.ada))
      .projectService.removeMember({ projectId: board.p1, userId: board.cy });
    await until(() => scopeOf(cy, "byProject", board.p1)?.error?.code === "FORBIDDEN");
    expect(scopeOf(cy, "byProject", board.p1)?.state).toBeNull();

    await write((db) => db.project.delete({ where: { id: board.p2 } }));
    await until(() => scopeOf(ed, "byProject", board.p2)?.error?.code === "NOT_FOUND");
    expect(scopeOf(ed, "byProject", board.p2)?.state).toBeNull();
  });

  it("paces a burst of subscriptions by the server's lane, so none is refused RATE_LIMITED", async () => {
    const { app } = await live.start();
    const board = live.board();
    const ada = await client(app.url, board.ada);
    const scopes = Array.from({ length: 100 }, (_, index) => `missing-${index}`);
    for (const scope of scopes) {
      ada.data.collections.subscribe(targetOf("byProject"), scope);
    }
    await until(
      () => scopes.every((scope) => (scopeOf(ada, "byProject", scope)?.error ?? null) !== null),
      10_000,
    );
    expect(scopes.map((scope) => scopeOf(ada, "byProject", scope)?.error?.code)).toEqual(
      scopes.map(() => "FORBIDDEN"),
    );
    expect(ada.connection.backoffRemaining("subscription")).toBe(0);
  });
});

describe("without a DOM", () => {
  it("runs with document undefined, and renders the hooks on a server", async () => {
    expect(typeof document).toBe("undefined");
    const { app } = await live.start();
    const board = live.board();
    const qd = createQuickdrawClient({ task: taskContract });
    function Board() {
      const row = qd.task.useEntity(board.t1);
      const scope = qd.task.board.useCollection(board.p1, { view: "mine" });
      return React.createElement("p", null, `${String(row.isLoading)} ${String(scope.isLoading)}`);
    }
    const Provider = QuickdrawProvider<{ readonly task: typeof taskContract }>;
    const html = renderToString(
      React.createElement(
        Provider,
        { client: qd, url: app.url, auth: { principal: as(board.ada) } },
        React.createElement(Board),
      ),
    );
    expect(html).toBe("<p>true true</p>");
  });
});
