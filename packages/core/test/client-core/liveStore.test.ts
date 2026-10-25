// A script's live store end to end (RFC 0003 section 11.5), in the
// `client-core` project: React and TanStack Query are refused in this
// process (scripts/refuse-react.mjs), so the client is reached through
// `src/client/core.ts` alone, as a Node script, a CLI or a worker reaches
// `@fitzzero/quickdraw-core/client/core`. Against the end-to-end app
// (`test/fixtures/app.ts`), as cy, who reads P1 as its member: the view of
// P1's board that cy's tasks make, kept current, resumed after an outage,
// refused when cy leaves P1, and emptied when the server ends cy's session.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as core from "../../src/client/core";
// The cache a live store's holdings read, which ./client/core does not export.
import { liveCacheOf } from "../../src/client/live/liveStore";
import { as, e2eApp, taskContract } from "../fixtures/app";

const e2e = e2eApp();
const connections: core.QuickdrawConnection[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) {
    connection.close();
  }
});

type App = Awaited<ReturnType<typeof e2e.start>>["app"];

/** A live store as `userId`, made before its connection opens, as a script makes it. */
function liveAs(app: App, userId: string): core.LiveStore {
  const connection = core.createQuickdrawConnection({
    url: app.url,
    auth: { principal: as(userId) },
    transports: ["websocket"],
  });
  connections.push(connection);
  const live = core.liveStoreOf(connection);
  connection.open();
  return live;
}

/** Drops the socket at its transport, as a network outage does, and keeps Socket.IO from reconnecting. */
async function drop(app: App, connection: core.QuickdrawConnection): Promise<void> {
  const { id } = connection.socket;
  connection.socket.io.reconnection(false);
  connection.socket.io.engine.close();
  await vi.waitFor(() => {
    expect(id !== undefined && app.server.io.sockets.sockets.has(id)).toBe(false);
  });
}

/** Lets Socket.IO connect again, and waits for the new socket's hello. */
async function bringBack(connection: core.QuickdrawConnection): Promise<void> {
  const before = connection.getState().hello;
  connection.socket.io.reconnection(true);
  connection.socket.connect();
  await vi.waitFor(() => {
    const { status, hello } = connection.getState();
    expect(status === "connected" && hello !== null && hello !== before).toBe(true);
  });
}

describe("a script's live store, with React and TanStack Query refused", () => {
  it("runs in a process that cannot load React or TanStack Query", async () => {
    // Vitest asks Node for each by its file: the hook refuses where it resolves to.
    const refused = (name: string): RegExp =>
      new RegExp(`^refused \\S*node_modules/${name}/.*runs without React and TanStack Query$`);
    await expect(import("react")).rejects.toThrow(refused("react"));
    await expect(import("@tanstack/react-query")).rejects.toThrow(refused("@tanstack/react-query"));
  });

  it("holds a view of a scope: kept current, resumed after an outage, refused when access goes", async () => {
    const { app, reads } = await e2e.start();
    const board = e2e.board();
    // Another script holds the board too: the server keeps its deltas while cy is away.
    const watcher = core.holdCollection(
      liveAs(app, board.bo),
      { contract: taskContract, collection: "board", scope: board.p1 },
      () => undefined,
    );
    const live = liveAs(app, board.cy);
    const titles: string[][] = [];
    const mine = core.holdCollection(
      live,
      { contract: taskContract, collection: "board", scope: board.p1, view: "mine" },
      (scope) => {
        titles.push(scope.items.map((card) => card.title));
      },
    );
    await vi.waitFor(() => {
      expect(mine.current().isLoading).toBe(false);
      expect(watcher.current().isLoading).toBe(false);
    });
    // T1 is on the board, and nobody's yet.
    expect(mine.current()).toMatchObject({ items: [], totalCount: 1, error: null });

    await app.as(as(board.bo)).taskService.assign({ id: board.t1, assigneeId: board.cy });
    await vi.waitFor(() => {
      expect(mine.current().items.map((card) => card.title)).toEqual(["T1"]);
    });
    expect(titles.at(-1)).toEqual(["T1"]);

    // An outage: bo renames T1 meanwhile. Back, the scope resumes from its revision.
    const pageReads = (): number => reads.filter((read) => read.args.take !== undefined).length;
    const before = pageReads();
    await drop(app, live.connection);
    await app.as(as(board.bo)).taskService.rename({ id: board.t1, title: "Renamed" });
    await bringBack(live.connection);
    await vi.waitFor(() => {
      expect(mine.current().items.map((card) => card.title)).toEqual(["Renamed"]);
    });
    expect(pageReads()).toBe(before);

    // ada takes cy off P1: the server ends the subscription, and nothing of it shows.
    await app
      .as(as(board.ada))
      .projectService.removeMember({ projectId: board.p1, userId: board.cy });
    await vi.waitFor(() => {
      expect(mine.current().error?.code).toBe("FORBIDDEN");
    });
    expect(mine.current().items).toEqual([]);
    mine.release();
  });

  it("keeps nothing of a session the server ends", async () => {
    const { app } = await e2e.start();
    const board = e2e.board();
    const live = liveAs(app, board.cy);
    const cards = core.holdCollection(
      live,
      { contract: taskContract, collection: "board", scope: board.p1 },
      () => undefined,
    );
    const row = core.holdEntity(live, { contract: taskContract, id: board.t1 }, () => undefined);
    await vi.waitFor(() => {
      expect(cards.current().items.map((card) => card.title)).toEqual(["T1"]);
      expect(row.current().data?.title).toBe("T1");
    });
    const cache = liveCacheOf(live);
    const held = (): string =>
      JSON.stringify([
        cache.get(core.collectionKey("taskService", "board", board.p1)),
        cache.get(core.entityKey("taskService", board.t1)),
      ]);
    expect(held()).toContain("T1");

    app.server.access.disconnectUser(board.cy);
    await vi.waitFor(() => {
      expect(live.connection.getState().hello).toBeNull();
      expect(held()).not.toContain("T1");
    });
    expect(cards.current()).toMatchObject({ items: [], totalCount: null });
    expect(row.current().data).toBeUndefined();
  });
});
