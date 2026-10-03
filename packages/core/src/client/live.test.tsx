// The hooks against a real server on PGlite with tracked writes (RFC 0003
// sections 11.3 and 11.4): watched topics joined once per topic and
// refetched once per `qd:changed`, refetches after a reconnect spread over
// the jitter window, `qd.invalidate`, and optimistic mutations.

import { QueryClient } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tick } from "../server/__tests__/fixtures";
import { as } from "../server/access/__tests__/board";
import type { Principal } from "../server/index";
import type { QuickdrawConnection } from "./connection";
import { createQuickdrawClient } from "./createClient";
import { overlaysOf } from "./optimistic";
import { QuickdrawProvider, useQuickdraw } from "./provider";
import { outgoing, until } from "./__tests__/fixtures";
import { callsOf, framesOf, liveHarness, taskContract, watchersOf } from "./__tests__/live";

const live = liveHarness();
const qd = createQuickdrawClient({ task: taskContract });

afterEach(() => {
  vi.restoreAllMocks();
});

interface Setup {
  readonly url: string;
  readonly principal: Principal;
  readonly queryClient: QueryClient;
}

function Provider({
  url,
  principal,
  queryClient,
  children,
}: Setup & { readonly children?: React.ReactNode }) {
  return (
    <QuickdrawProvider
      client={qd}
      url={url}
      auth={{ principal }}
      transports={["websocket"]}
      queryClient={queryClient}
    >
      {children}
    </QuickdrawProvider>
  );
}

/** A provider for `renderHook`, and the connection it made (with the frames it sends from the start). */
function wrapperFor(setup: Setup) {
  const grabbed: { connection?: QuickdrawConnection; sent: unknown[][] } = { sent: [] };
  function Grab() {
    const { connection } = useQuickdraw();
    if (grabbed.connection === undefined) {
      grabbed.connection = connection;
      grabbed.sent = outgoing(connection);
    }
    return null;
  }
  const wrapper = ({ children }: { readonly children?: React.ReactNode }) => (
    <Provider {...setup}>
      <Grab />
      {children}
    </Provider>
  );
  return { wrapper, grabbed };
}

function freshClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false } },
  });
}

describe("a watched query", () => {
  it("joins its topic once for two hooks, refetches once for ten writes in one call, and leaves after the last hook", async () => {
    const { app, records } = await live.start();
    const board = live.board();
    const { wrapper, grabbed } = wrapperFor({
      url: app.url,
      principal: as(board.ada),
      queryClient: freshClient(),
    });
    function Count() {
      const { data } = qd.task.countOnBoard.useQuery({ projectId: board.p1 });
      return <p>{`count ${String(data)}`}</p>;
    }
    function Board({ copies }: { readonly copies: number }) {
      return wrapper({
        children: Array.from({ length: copies }, (_, index) => <Count key={index} />),
      });
    }
    const view = render(<Board copies={2} />);
    await waitFor(() => expect(screen.getAllByText("count 1")).toHaveLength(2));
    await until(() => watchersOf(app, board.p1) === 1);
    const sent = (): unknown[][] => grabbed.sent;
    expect(framesOf(sent(), "qd:watch")).toEqual([
      { s: "taskService", topic: `board:${board.p1}` },
    ]);
    const changed: unknown[] = [];
    grabbed.connection?.socket.on("qd:changed", (frame) => changed.push(frame));
    const reads = (): number => records.filter((record) => record.method === "countOnBoard").length;
    expect(reads()).toBe(1);
    await app.as(as(board.ada)).taskService.renameTenTimes({ id: board.t1 });
    await until(() => reads() === 2);
    await tick(400);
    expect(changed).toEqual([
      { s: "taskService", topic: `board:${board.p1}`, rev: expect.any(Number) },
    ]);
    expect(reads()).toBe(2);
    view.rerender(<Board copies={1} />);
    await tick(50);
    expect(framesOf(sent(), "qd:unwatch")).toEqual([]);
    view.rerender(<Board copies={0} />);
    await until(() => watchersOf(app, board.p1) === 0);
    expect(framesOf(sent(), "qd:unwatch")).toEqual([
      { s: "taskService", topic: `board:${board.p1}` },
    ]);
  });

  it("is invalidated without cancelling the read in flight, and read once more after it", async () => {
    const { app, records } = await live.start();
    const board = live.board();
    const { wrapper, grabbed } = wrapperFor({
      url: app.url,
      principal: as(board.ada),
      queryClient: freshClient(),
    });
    const { result } = renderHook(() => qd.task.cards.useQuery({ projectId: board.p1 }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.data).toEqual([{ id: board.t1, title: "T1" }]));
    await until(() => watchersOf(app, board.p1) === 1);
    await act(async () => {
      qd.invalidate(qd.task.cards, { projectId: board.p1 });
      await app.as(as(board.ada)).taskService.renameTenTimes({ id: board.t1 });
      qd.invalidate(qd.task.cards);
    });
    await waitFor(() => expect(result.current.data).toEqual([{ id: board.t1, title: "Round 10" }]));
    await tick(400);
    // The first read, the first invalidation's, and at most one more for
    // everything that arrived while that one was in flight or its window open.
    const reads = records.filter((record) => record.method === "cards");
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(reads.length).toBeLessThanOrEqual(4);
    expect(reads.every((record) => record.outcome === "ok")).toBe(true);
    expect(framesOf(grabbed.sent, "qd:cancel")).toEqual([]);
  });

  it("joins its topic once in strict mode, which mounts its effects twice", async () => {
    const { app } = await live.start();
    const board = live.board();
    const { wrapper, grabbed } = wrapperFor({
      url: app.url,
      principal: as(board.ada),
      queryClient: freshClient(),
    });
    function Count() {
      const { data } = qd.task.countOnBoard.useQuery({ projectId: board.p1 });
      return <p>{`count ${String(data)}`}</p>;
    }
    function Page({ show }: { readonly show: boolean }) {
      return wrapper({ children: <React.StrictMode>{show ? <Count /> : null}</React.StrictMode> });
    }
    const view = render(<Page show={false} />);
    await until(() => grabbed.connection?.getState().status === "connected");
    // Mounted on a connected socket, so the double mount would send frames.
    view.rerender(<Page show />);
    await screen.findByText("count 1");
    await until(() => watchersOf(app, board.p1) === 1);
    await tick(100);
    expect(framesOf(grabbed.sent, "qd:watch")).toHaveLength(1);
    expect(framesOf(grabbed.sent, "qd:unwatch")).toEqual([]);
  });
});

describe("after a reconnect", () => {
  it("refetches the watched and the stale queries after a random delay, and leaves fresh ones", async () => {
    const { app } = await live.start();
    const board = live.board();
    const other = await live.prisma().task.create({ data: { projectId: board.p1, title: "T3" } });
    const queryClient = freshClient();
    const { wrapper, grabbed } = wrapperFor({
      url: app.url,
      principal: as(board.ada),
      queryClient,
    });
    const { result } = renderHook(
      () => ({
        watched: qd.task.countOnBoard.useQuery({ projectId: board.p1 }),
        stale: qd.task.get.useQuery({ id: board.t1 }, { staleTime: 0 }),
        fresh: qd.task.get.useQuery({ id: other.id }),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.fresh.data?.title).toBe("T3"));
    await waitFor(() => expect(result.current.stale.data?.title).toBe("T1"));
    await until(() => watchersOf(app, board.p1) === 1);
    const connection = grabbed.connection as QuickdrawConnection;
    const sent = grabbed.sent;
    const before = sent.length;
    const since = (): unknown[][] => sent.slice(before);
    const reads = (m: string, id?: string): number =>
      callsOf(since(), m).filter(
        (call) => id === undefined || (call.i as { id?: string }).id === id,
      ).length;
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const first = connection.socket.id;
    app.server.rotate({ withinMs: 0 });
    await until(
      () => connection.socket.id !== first && connection.getState().status === "connected",
    );
    await until(() => watchersOf(app, board.p1) === 1);
    expect(framesOf(since(), "qd:watch")).toHaveLength(1);
    await tick(500);
    expect([reads("countOnBoard"), reads("get")]).toEqual([0, 0]);
    await until(() => reads("countOnBoard") === 1 && reads("get", board.t1) === 1, 3000);
    await tick(300);
    expect(reads("get", other.id)).toBe(0);
    expect([reads("countOnBoard"), reads("get", board.t1)]).toEqual([1, 1]);
  });
});

describe("qd.invalidate", () => {
  it("refetches one input, every input of a member, or what a key prefixes", async () => {
    const { app, records } = await live.start();
    const board = live.board();
    const { wrapper } = wrapperFor({
      url: app.url,
      principal: as(board.ada),
      queryClient: freshClient(),
    });
    const { result } = renderHook(
      () => [
        qd.task.get.useQuery({ id: board.t1 }),
        qd.task.countOnBoard.useQuery({ projectId: board.p1 }),
      ],
      { wrapper },
    );
    await waitFor(() => expect(result.current.every((query) => query.isSuccess)).toBe(true));
    const reads = (m: string): number => records.filter((record) => record.method === m).length;
    act(() => {
      qd.invalidate(qd.task.get, { id: board.t1 });
    });
    await until(() => reads("get") === 2);
    act(() => {
      qd.invalidate(qd.task.countOnBoard);
    });
    await until(() => reads("countOnBoard") === 2);
    await tick(300);
    act(() => {
      qd.invalidate(["qd", "taskService"]);
    });
    await until(() => reads("get") === 3 && reads("countOnBoard") === 3);
    expect(() => {
      qd.invalidate({} as never);
    }).toThrow("qd.invalidate: pass a query member");
  });

  it("needs a mounted provider", () => {
    expect(() => {
      qd.invalidate(qd.task.get);
    }).toThrow("qd.invalidate needs a mounted <QuickdrawProvider> for this client");
  });
});

describe("an optimistic mutation", () => {
  async function renamed() {
    const { app, gate } = await live.start();
    const board = live.board();
    const queryClient = freshClient();
    const { wrapper } = wrapperFor({ url: app.url, principal: as(board.ada), queryClient });
    const view = renderHook(
      () => ({
        get: qd.task.get.useQuery({ id: board.t1 }),
        cards: qd.task.cards.useQuery({ projectId: board.p1 }),
        rename: qd.task.rename.useMutation(),
        quiet: qd.task.rename.useMutation({ optimistic: false }),
        custom: qd.task.rename.useMutation({
          optimistic: (input, cache) => {
            cache.patchEntity(input.id, { title: `${input.title} (saving)` });
            cache.patchItem("board", input.id, { title: "on the board" });
          },
        }),
      }),
      { wrapper },
    );
    await waitFor(() => expect(view.result.current.get.data?.title).toBe("T1"));
    await waitFor(() => expect(view.result.current.cards.data).toHaveLength(1));
    return { app, gate, board, queryClient, view };
  }

  it("shows the new value before the reply, and keeps it over results read before the reply", async () => {
    const { app, gate, board, queryClient, view } = await renamed();
    const release = gate.hold();
    act(() => {
      view.result.current.rename.mutate({ id: board.t1, title: "Renamed" });
    });
    await waitFor(() => expect(view.result.current.get.data?.title).toBe("Renamed"));
    expect(view.result.current.cards.data).toEqual([{ id: board.t1, title: "Renamed" }]);
    const getKey = qd.task.get.key({ id: board.t1 });
    expect(queryClient.getQueryData(getKey)).toMatchObject({ title: "T1" });
    release();
    await waitFor(() => expect(view.result.current.rename.isSuccess).toBe(true));
    // Someone else renames it again. The watched list is read again after
    // the reply and shows the server's title; `get` was read before the
    // reply and keeps showing the user's edit over its older copy.
    await app.as(as(board.bo)).taskService.rename({ id: board.t1, title: "Elsewhere" });
    await waitFor(() =>
      expect(view.result.current.cards.data).toEqual([{ id: board.t1, title: "Elsewhere" }]),
    );
    expect(view.result.current.get.data?.title).toBe("Renamed");
    expect(queryClient.getQueryData(getKey)).toMatchObject({ title: "T1" });
    await act(async () => {
      await view.result.current.get.refetch();
    });
    await waitFor(() => expect(view.result.current.get.data?.title).toBe("Elsewhere"));
    expect(view.result.current.get.data).toEqual(queryClient.getQueryData(getKey));
  });

  it("restores the old value when the server refuses it", async () => {
    const { gate, board, view } = await renamed();
    const release = gate.hold();
    act(() => {
      view.result.current.rename.mutate({ id: board.t1, title: "conflict" });
    });
    await waitFor(() => expect(view.result.current.get.data?.title).toBe("conflict"));
    release();
    await waitFor(() => expect(view.result.current.rename.error?.code).toBe("CONFLICT"));
    expect(view.result.current.get.data?.title).toBe("T1");
    expect(view.result.current.cards.data).toEqual([{ id: board.t1, title: "T1" }]);
  });

  it("is dropped by a frame newer than every revision seen before the write, and not by an older one", async () => {
    const { board, queryClient, view } = await renamed();
    const overlays = overlaysOf(queryClient);
    act(() => {
      overlays.observe("taskService", board.t1, 100);
    });
    await act(async () => {
      await view.result.current.rename.mutateAsync({ id: board.t1, title: "Renamed" });
    });
    expect(view.result.current.get.data?.title).toBe("Renamed");
    act(() => {
      overlays.observe("taskService", board.t1, 100);
    });
    expect(view.result.current.get.data?.title).toBe("Renamed");
    act(() => {
      overlays.observe("taskService", board.t1, 101);
    });
    await waitFor(() => expect(view.result.current.get.data?.title).toBe("T1"));
  });

  it("with optimistic: false changes nothing until the reply", async () => {
    const { gate, board, view } = await renamed();
    const release = gate.hold();
    act(() => {
      view.result.current.quiet.mutate({ id: board.t1, title: "Quiet" });
    });
    await tick(200);
    expect(view.result.current.get.data?.title).toBe("T1");
    release();
    await waitFor(() => expect(view.result.current.quiet.data?.title).toBe("Quiet"));
    expect(view.result.current.get.data?.title).toBe("T1");
  });

  it("can write its own layers instead, which a failure drops", async () => {
    const { gate, board, queryClient, view } = await renamed();
    const overlays = overlaysOf(queryClient);
    const item = { id: board.t1, title: "T1" };
    const release = gate.hold();
    act(() => {
      view.result.current.custom.mutate({ id: board.t1, title: "conflict" });
    });
    await waitFor(() => expect(view.result.current.get.data?.title).toBe("conflict (saving)"));
    expect(overlays.applyOverlay("taskService", item, { collection: "board" })).toEqual({
      id: board.t1,
      title: "on the board",
    });
    release();
    await waitFor(() => expect(view.result.current.custom.isError).toBe(true));
    expect(view.result.current.get.data?.title).toBe("T1");
    expect(overlays.applyOverlay("taskService", item, { collection: "board" })).toBe(item);
  });
});
