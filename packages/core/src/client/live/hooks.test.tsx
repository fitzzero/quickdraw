// The live hooks through the typed client, against a real server on PGlite
// with tracked writes (RFC 0003 sections 6, 7, 11.4 and 11.5):
// `qd.task.useEntity`, `useEntities` and `qd.task.<collection>.useCollection`.

import { act, renderHook, waitFor } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it } from "vitest";
import { tick } from "../../server/__tests__/fixtures";
import type { QuickdrawConnection } from "../connection";
import { createQuickdrawClient } from "../createClient";
import { QuickdrawProvider, useQuickdraw } from "../provider";
import { outgoing, until } from "../__tests__/fixtures";
import { as, freshClient, liveDataHarness, taskContract } from "./__tests__/server";

const live = liveDataHarness();
const qd = createQuickdrawClient({ task: taskContract });

/** A provider acting as `userId`, and the connection it made with the frames it sends. */
function wrapperFor(url: string, userId: string, strict = false) {
  const grabbed: { connection?: QuickdrawConnection; sent: unknown[][] } = { sent: [] };
  const queryClient = freshClient();
  function Grab() {
    const { connection } = useQuickdraw();
    if (grabbed.connection === undefined) {
      grabbed.connection = connection;
      grabbed.sent = outgoing(connection);
    }
    return null;
  }
  function Wrapper({ children }: { readonly children?: React.ReactNode }) {
    const tree = (
      <QuickdrawProvider
        client={qd}
        url={url}
        auth={{ principal: as(userId) }}
        transports={["websocket"]}
        queryClient={queryClient}
      >
        <Grab />
        {children}
      </QuickdrawProvider>
    );
    return strict ? <React.StrictMode>{tree}</React.StrictMode> : tree;
  }
  return { wrapper: Wrapper, grabbed, queryClient };
}

function framesOf(sent: readonly unknown[][], event: string): unknown[] {
  return sent.filter(([name]) => name === event).map(([, frame]) => frame);
}

describe("useEntity and useEntities", () => {
  it("loads a row, follows its changes, and shows its removal", async () => {
    const { app, write } = await live.start();
    const board = live.board();
    const { wrapper } = wrapperFor(app.url, board.ada);
    const { result } = renderHook(() => qd.task.useEntity(board.t1), { wrapper });

    expect(result.current).toMatchObject({ data: undefined, isLoading: true, isRemoved: false });
    await waitFor(() => expect(result.current.data?.title).toBe("T1"));
    expect(result.current.isLoading).toBe(false);
    await act(async () => {
      await write((db) => db.task.update({ where: { id: board.t1 }, data: { status: "done" } }));
    });
    await waitFor(() => expect(result.current.data?.status).toBe("done"));
    await act(async () => {
      await write((db) => db.task.delete({ where: { id: board.t1 } }));
    });
    await waitFor(() => expect(result.current.isRemoved).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  it("shows FORBIDDEN for a row the user may not read, and holds nothing without an id", async () => {
    const { app } = await live.start();
    const board = live.board();
    const { wrapper, grabbed } = wrapperFor(app.url, board.ed);
    const { result } = renderHook(
      () => ({
        refused: qd.task.useEntity(board.t1),
        none: qd.task.useEntity(null),
        off: qd.task.useEntity(board.t2, { enabled: false }),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.refused.error?.code).toBe("FORBIDDEN"));
    expect(result.current.refused.isLoading).toBe(false);
    expect(result.current.none.isLoading).toBe(false);
    expect(result.current.off).toMatchObject({ data: undefined, isLoading: false });
    expect(framesOf(grabbed.sent, "qd:sub")).toEqual([{ s: "taskService", ids: [board.t1] }]);
  });

  it("loads rows together, in the order asked for, with each failure on its own", async () => {
    const { app } = await live.start();
    const board = live.board();
    const { wrapper, grabbed } = wrapperFor(app.url, board.ada);
    const { result } = renderHook(() => qd.task.useEntities([board.t1, board.t2, "missing"]), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data.map((row) => row?.title)).toEqual(["T1", undefined, undefined]);
    expect([...result.current.byId.keys()]).toEqual([board.t1]);
    expect(result.current.errors.get(board.t2)?.code).toBe("FORBIDDEN");
    expect(result.current.error?.code).toBe("FORBIDDEN");
    expect(framesOf(grabbed.sent, "qd:sub")).toHaveLength(1);
  });

  it("subscribes once in strict mode, which mounts effects twice", async () => {
    const { app } = await live.start();
    const board = live.board();
    const { wrapper, grabbed } = wrapperFor(app.url, board.ada, true);
    const { result } = renderHook(
      () => [qd.task.useEntity(board.t1), qd.task.board.useCollection(board.p1)],
      { wrapper },
    );
    await waitFor(() => expect(result.current[0]?.isLoading).toBe(false));
    await tick(100);
    expect(framesOf(grabbed.sent, "qd:sub")).toHaveLength(1);
    expect(framesOf(grabbed.sent, "qd:col:sub")).toHaveLength(1);
    expect(framesOf(grabbed.sent, "qd:unsub")).toEqual([]);
    expect(framesOf(grabbed.sent, "qd:col:unsub")).toEqual([]);
  });
});

describe("useCollection", () => {
  it("shows a scope's members and items, follows writes, and pages with loadMore", async () => {
    const { app, write } = await live.start();
    const board = live.board();
    await live.prisma().task.createMany({
      data: Array.from({ length: 11 }, (_, index) => ({
        projectId: board.p1,
        title: `Task ${index + 1}`,
        ordinal: index + 1,
      })),
    });
    const { wrapper } = wrapperFor(app.url, board.ada);
    const { result } = renderHook(() => qd.task.board.useCollection(board.p1), { wrapper });
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.index).toHaveLength(12);
    expect(result.current.items).toHaveLength(10);
    expect(result.current.totalCount).toBe(12);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.index?.[0]).toEqual({
      id: board.t1,
      status: "open",
      ordinal: 0,
      assigneeId: null,
    });

    await act(async () => {
      await result.current.loadMore();
    });
    // TanStack tells observers of a cache write on a later task.
    await waitFor(() => expect(result.current.items).toHaveLength(12));
    expect(result.current.hasMore).toBe(false);
    await act(async () => {
      await write((db) => db.task.update({ where: { id: board.t1 }, data: { title: "Renamed" } }));
    });
    await waitFor(() => expect(result.current.byId.get(board.t1)?.title).toBe("Renamed"));
  });

  it("filters by the contract's view for the user, live", async () => {
    const { app, write } = await live.start();
    const board = live.board();
    const { wrapper } = wrapperFor(app.url, board.ada);
    const { result } = renderHook(
      () => ({
        mine: qd.task.board.useCollection(board.p1, { view: "mine" }),
        all: qd.task.board.useCollection(board.p1),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.all.isLoading).toBe(false));
    expect(result.current.mine.index).toEqual([]);
    expect(result.current.mine.items).toEqual([]);

    await act(async () => {
      await write((db) =>
        db.task.update({ where: { id: board.t1 }, data: { assigneeId: board.ada } }),
      );
    });
    await waitFor(() =>
      expect(result.current.mine.items.map((item) => item.id)).toEqual([board.t1]),
    );
    expect(result.current.mine.totalCount).toBe(1);
    await act(async () => {
      await write((db) =>
        db.task.update({ where: { id: board.t1 }, data: { assigneeId: board.bo } }),
      );
    });
    await waitFor(() => expect(result.current.mine.index).toEqual([]));
    expect(result.current.all.items).toHaveLength(1);
  });

  it("with load: all, loads every page", async () => {
    const { app } = await live.start();
    const board = live.board();
    await live.prisma().task.createMany({
      data: Array.from({ length: 24 }, (_, index) => ({
        projectId: board.p1,
        title: `Task ${index}`,
        ordinal: index + 1,
      })),
    });
    const { wrapper, grabbed } = wrapperFor(app.url, board.ada);
    const { result } = renderHook(
      () => qd.task.board.useCollection(board.p1, { load: "all", limit: 10 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.items).toHaveLength(25));
    expect(result.current.hasMore).toBe(false);
    await tick(100);
    expect(framesOf(grabbed.sent, "qd:col:sub")).toHaveLength(3);
  });

  it("loads chosen members with loadItems, flags a clamped page size, and reloads with refresh", async () => {
    const { app } = await live.start();
    const board = live.board();
    const tasks = await live.prisma().task.createManyAndReturn({
      data: [1, 2, 3, 4].map((ordinal) => ({
        projectId: board.p1,
        title: `Open ${ordinal}`,
        ordinal,
      })),
    });
    const { wrapper, grabbed } = wrapperFor(app.url, board.ada);
    const { result } = renderHook(
      () => qd.task.openByProject.useCollection(board.p1, { limit: 5 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.clamped).toBe(true);
    expect(result.current.items).toHaveLength(3);
    const last = tasks[3]?.id ?? "";

    await act(async () => {
      await result.current.loadItems([last]);
    });
    await waitFor(() => expect(result.current.byId.get(last)?.title).toBe("Open 4"));
    await act(async () => {
      await result.current.refresh();
    });
    expect(framesOf(grabbed.sent, "qd:col:sub")).toHaveLength(2);
    expect(result.current.error).toBeNull();
  });

  it("shows nothing of a cached row or scope once disabled, and lets their subscriptions go", async () => {
    const { app } = await live.start();
    const board = live.board();
    const { wrapper, grabbed } = wrapperFor(app.url, board.ada);
    const { result, rerender } = renderHook(
      ({ enabled }: { readonly enabled: boolean }) => ({
        row: qd.task.useEntity(board.t1, { enabled }),
        rows: qd.task.useEntities([board.t1], { enabled }),
        scope: qd.task.board.useCollection(board.p1, { enabled }),
      }),
      { wrapper, initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.row.data?.title).toBe("T1"));
    await waitFor(() => expect(result.current.scope.items).toHaveLength(1));
    expect(result.current.rows.data.map((row) => row?.title)).toEqual(["T1"]);

    rerender({ enabled: false });
    expect(result.current.row).toEqual({
      data: undefined,
      isLoading: false,
      isRemoved: false,
      error: null,
    });
    expect(result.current.rows).toMatchObject({ data: [undefined], isLoading: false, error: null });
    expect(result.current.rows.byId.size).toBe(0);
    expect(result.current.scope).toMatchObject({
      items: [],
      index: undefined,
      totalCount: null,
      hasMore: false,
      isLoading: false,
      error: null,
    });
    await until(
      () =>
        framesOf(grabbed.sent, "qd:unsub").length === 1 &&
        framesOf(grabbed.sent, "qd:col:unsub").length === 1,
    );
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.row.data?.title).toBe("T1"));
  });

  it("holds nothing for a null scope or a disabled hook", async () => {
    const { app } = await live.start();
    const board = live.board();
    const { wrapper, grabbed } = wrapperFor(app.url, board.ada);
    const { result } = renderHook(
      () => [
        qd.task.board.useCollection(null),
        qd.task.board.useCollection(board.p1, { enabled: false }),
      ],
      { wrapper },
    );
    await tick(200);
    expect(grabbed.connection?.getState().status).toBe("connected");
    expect(framesOf(grabbed.sent, "qd:col:sub")).toEqual([]);
    expect(result.current.map((scope) => scope.isLoading)).toEqual([false, false]);
  });
});

describe("optimistic overlays", () => {
  it("show over a live row and its items until the write's frame arrives", async () => {
    const { app } = await live.start();
    const board = live.board();
    const { wrapper } = wrapperFor(app.url, board.ada);
    const titles: (string | undefined)[] = [];
    const { result } = renderHook(
      () => {
        const row = qd.task.useEntity(board.t1);
        const items = qd.task.byProject.useCollection(board.p1);
        titles.push(`${String(row.data?.title)} / ${String(items.items[0]?.title)}`);
        return {
          row,
          items,
          rename: qd.task.renameTenTimes.useMutation({
            optimistic: (input, cache) => {
              cache.patchEntity(input.id, { title: "Saving" });
            },
          }),
        };
      },
      { wrapper },
    );
    await waitFor(() => expect(titles.at(-1)).toBe("T1 / T1"));
    titles.length = 0;

    act(() => {
      result.current.rename.mutate({ id: board.t1 });
    });
    await waitFor(() => expect(titles.at(-1)).toBe("Round 10 / Round 10"));
    // The layer showed at once over both, and ended at the frames of the write.
    expect(titles[0]).toBe("Saving / Saving");
    expect(titles).not.toContain("T1 / T1");
    expect(result.current.rename.isSuccess).toBe(true);
  });
});
