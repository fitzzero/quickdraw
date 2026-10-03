// The cache follows the user each `qd:hello` names (RFC 0003 sections 6, 8.1,
// 11.1 and 11.5): another user's hello removes everything quickdraw cached,
// held or not, before anything of it is shown to them or sent on their
// behalf, and the same user on new credentials keeps it. The first block
// drives the session over a fake connection; the others render the hooks
// against a real server, switching the provider's credentials from Ada
// (Admin on P1, who may read a task's `notes`) to Cy (Read on P1) or Ed (no
// access to P1).

import { QueryClient } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { deferred, tick } from "../server/__tests__/fixtures";
import type { QuickdrawConnection } from "./connection";
import { createQuickdrawClient } from "./createClient";
import { collectionKey, entityKey, methodKey } from "./keys";
import { fakeConnection, fakeHello } from "./live/__tests__/fakeSocket";
import { as, freshClient, liveDataHarness, taskContract } from "./live/__tests__/server";
import { mutateOptimistically, overlaysOf } from "./optimistic";
import { QuickdrawProvider, useQuickdraw } from "./provider";
import { sessionOf } from "./session";
import { outgoing, until } from "./__tests__/fixtures";
import { callsOf, framesOf } from "./__tests__/live";

const live = liveDataHarness();
const qd = createQuickdrawClient({ task: taskContract });

describe("the session of a connection and a QueryClient", () => {
  function setup() {
    const fake = fakeConnection();
    fake.setState({ hello: null });
    const queryClient = new QueryClient();
    const session = sessionOf(fake.connection, queryClient);
    const changes: unknown[] = [];
    session.onHello((change) => changes.push(change));
    const keys = [
      methodKey("taskService", "get", { id: "t1" }),
      entityKey("taskService", "t1"),
      collectionKey("taskService", "byProject", "p1"),
    ];
    const fill = (): void => {
      for (const key of keys) {
        queryClient.setQueryData(key, { id: "t1", notes: "SECRET" });
      }
    };
    const cached = (): unknown[] => keys.map((key) => queryClient.getQueryData(key));
    return { fake, queryClient, changes, fill, cached };
  }

  it("removes every quickdraw query and every overlay when a hello names another user", async () => {
    const { fake, queryClient, changes, fill, cached } = setup();
    fake.setState({ hello: fakeHello("ada") });
    fill();
    queryClient.setQueryData(["app", "own"], "kept");
    const overlays = overlaysOf(queryClient);
    void mutateOptimistically(
      queryClient,
      { service: "taskService", entityOutput: true },
      undefined,
      { id: "t1", title: "Pending" },
      () => deferred<unknown>().promise,
    );
    expect(overlays.applyOverlay("taskService", { id: "t1", title: "T1" })).toEqual({
      id: "t1",
      title: "Pending",
    });
    const told = vi.fn();
    overlays.subscribe(told);

    fake.setState({ hello: null });
    expect(cached()).not.toContain(undefined);
    fake.setState({ hello: fakeHello("cy") });
    expect(cached()).toEqual([undefined, undefined, undefined]);
    expect(queryClient.getQueryData(["app", "own"])).toBe("kept");
    expect(overlays.applyOverlay("taskService", { id: "t1", title: "T1" })).toEqual({
      id: "t1",
      title: "T1",
    });
    expect(told).toHaveBeenCalled();
    expect(changes).toEqual([
      { switched: false, first: true },
      { switched: true, first: true },
    ]);
  });

  it("counts an anonymous socket as a user of its own", () => {
    const { fake, fill, cached } = setup();
    fake.setState({ hello: fakeHello(null) });
    fill();
    fake.setState({ hello: fakeHello("ada") });
    expect(cached()).toEqual([undefined, undefined, undefined]);
    fill();
    fake.setState({ hello: fakeHello(null) });
    expect(cached()).toEqual([undefined, undefined, undefined]);
  });

  it("keeps the cache and refetches it on new credentials for the same user, and does nothing on a reconnect", () => {
    const { fake, queryClient, changes, fill, cached } = setup();
    fake.setState({ hello: fakeHello("ada") });
    fill();
    const held = cached();
    const query = () =>
      queryClient.getQueryCache().find({ queryKey: methodKey("taskService", "get", { id: "t1" }) });
    // A reconnect with the same credentials: a new hello, no null between.
    fake.setState({ hello: fakeHello("ada") });
    expect(query()?.state.isInvalidated).toBe(false);
    // New credentials: the hello is dropped, then the same user's arrives.
    fake.setState({ hello: null });
    fake.setState({ hello: fakeHello("ada") });
    expect(cached()).toEqual(held);
    expect(query()?.state.isInvalidated).toBe(true);
    expect(changes).toEqual([
      { switched: false, first: true },
      { switched: false, first: false },
      { switched: false, first: true },
    ]);
  });

  it("settles a cache loaded for another user when it is made on a connection that has its hello", () => {
    const fake = fakeConnection();
    const queryClient = new QueryClient();
    sessionOf(fake.connection, queryClient);
    queryClient.setQueryData(entityKey("taskService", "t1"), { id: "t1" });
    // A second connection, as another user, on the same cache.
    const other = fakeConnection();
    other.setState({ hello: fakeHello("cy") });
    sessionOf(other.connection, queryClient);
    expect(queryClient.getQueryData(entityKey("taskService", "t1"))).toBeUndefined();
  });
});

/** A provider whose credentials the test switches, the frames its connection sends, and its cache. */
function switchable(url: string) {
  const queryClient = freshClient();
  const grabbed: { connection?: QuickdrawConnection; sent: unknown[][] } = { sent: [] };
  function Grab() {
    const { connection, userId } = useQuickdraw();
    if (grabbed.connection === undefined) {
      grabbed.connection = connection;
      grabbed.sent = outgoing(connection);
    }
    return <p>{`as ${userId ?? "-"}`}</p>;
  }
  const tree = (auth: Record<string, unknown>, children: React.ReactNode) => (
    <QuickdrawProvider
      client={qd}
      url={url}
      auth={auth}
      transports={["websocket"]}
      queryClient={queryClient}
    >
      <Grab />
      {children}
    </QuickdrawProvider>
  );
  return { tree, grabbed, queryClient };
}

/** What each render showed, with the user the connection acted for then. */
type Seen = [user: string | null, shown: string][];

function shownTo(seen: Seen, user: string): string[] {
  return seen.filter(([who]) => who === user).map(([, shown]) => shown);
}

describe("switching users on one provider", () => {
  async function started() {
    const { app } = await live.start();
    const board = live.board();
    await live.prisma().task.update({ where: { id: board.t1 }, data: { notes: "SECRET" } });
    return { app, board };
  }

  function TaskQuery({ id, seen }: { readonly id: string; readonly seen: Seen }) {
    const { userId } = useQuickdraw();
    const { data, error } = qd.task.get.useQuery({ id });
    const shown =
      error === null
        ? `get ${data === undefined ? "none" : `${data.title}/${String(data.notes)}`}`
        : `get refused ${error.code}`;
    seen.push([userId, shown]);
    return <p>{shown}</p>;
  }

  it("shows the next user nothing a query read as the last one, and reads it without its version", async () => {
    const { app, board } = await started();
    const { tree, grabbed } = switchable(app.url);
    const seen: Seen = [];
    const ui = (who: string) =>
      tree({ principal: as(who) }, <TaskQuery id={board.t1} seen={seen} />);
    const view = render(ui(board.ada));
    await screen.findByText("get T1/SECRET");
    view.rerender(ui(board.cy));
    await screen.findByText(`as ${board.cy}`);
    await screen.findByText("get T1/undefined");
    expect(shownTo(seen, board.cy).filter((shown) => shown.includes("SECRET"))).toEqual([]);
    const gets = callsOf(grabbed.sent, "get");
    expect(gets).toHaveLength(2);
    expect(gets[1]).not.toHaveProperty("v");
  });

  it("shows a user who may not read the row no data next to FORBIDDEN", async () => {
    const { app, board } = await started();
    const { tree } = switchable(app.url);
    const seen: Seen = [];
    const ui = (who: string) =>
      tree({ principal: as(who) }, <TaskQuery id={board.t1} seen={seen} />);
    const view = render(ui(board.ada));
    await screen.findByText("get T1/SECRET");
    view.rerender(ui(board.ed));
    await screen.findByText("get refused FORBIDDEN");
    await tick(200);
    expect(shownTo(seen, board.ed).filter((shown) => shown.includes("T1"))).toEqual([]);
    expect(screen.getByText("get refused FORBIDDEN")).toBeTruthy();
  });

  it("shows a row unmounted before the switch as nothing of the last user's when it mounts again", async () => {
    const { app, board } = await started();
    const { tree, grabbed } = switchable(app.url);
    const seen: Seen = [];
    function Row() {
      const { userId } = useQuickdraw();
      const { data } = qd.task.useEntity(board.t1);
      const shown = `row ${data === undefined ? "none" : `${data.title}/${String(data.notes)}`}`;
      seen.push([userId, shown]);
      return <p>{shown}</p>;
    }
    const ui = (who: string, show: boolean) =>
      tree({ principal: as(who) }, show ? <Row /> : <p>hidden</p>);
    const view = render(ui(board.ada, true));
    await screen.findByText("row T1/SECRET");
    view.rerender(ui(board.ada, false));
    await until(() => framesOf(grabbed.sent, "qd:unsub").length === 1);
    view.rerender(ui(board.cy, false));
    await screen.findByText(`as ${board.cy}`);
    view.rerender(ui(board.cy, true));
    expect(shownTo(seen, board.cy)[0]).toBe("row none");
    await screen.findByText("row T1/undefined");
    expect(shownTo(seen, board.cy).filter((shown) => shown.includes("SECRET"))).toEqual([]);
    // Cy's subscribe named no revision of Ada's row.
    expect(framesOf(grabbed.sent, "qd:sub").at(-1)).toEqual({ s: "taskService", ids: [board.t1] });
  });

  it("shows nothing of the last user's scopes, held or mounted again, before the next user's load", async () => {
    const { app, board } = await started();
    const { tree } = switchable(app.url);
    const seen: Seen = [];
    interface Shown {
      readonly error: { readonly code: string } | null;
      readonly items: readonly { readonly title: string }[];
    }
    function useShown(name: string, scope: Shown) {
      const { userId } = useQuickdraw();
      const shown = `${name} ${scope.error?.code ?? scope.items.map((item) => item.title).join(",")}`;
      seen.push([userId, shown]);
      return <p>{shown}</p>;
    }
    function ByProject() {
      return useShown("byProject", qd.task.byProject.useCollection(board.p1));
    }
    function Board() {
      return useShown("board", qd.task.board.useCollection(board.p1));
    }
    const ui = (who: string, show: boolean) =>
      tree(
        { principal: as(who) },
        <>
          <ByProject />
          {show ? <Board /> : null}
        </>,
      );
    const view = render(ui(board.ada, true));
    await screen.findByText("byProject T1");
    await screen.findByText("board T1");
    view.rerender(ui(board.ada, false));
    await tick(50);
    view.rerender(ui(board.ed, false));
    await screen.findByText(`as ${board.ed}`);
    view.rerender(ui(board.ed, true));
    await screen.findByText("byProject FORBIDDEN");
    await screen.findByText("board FORBIDDEN");
    expect(shownTo(seen, board.ed).filter((shown) => shown.includes("T1"))).toEqual([]);
  });

  it("keeps the cache of the same user on new credentials, and refetches it with the versions held", async () => {
    const { app, board } = await started();
    const { tree, grabbed, queryClient } = switchable(app.url);
    const seen: Seen = [];
    function Row() {
      const { data } = qd.task.useEntity(board.t1);
      return <p>{`row ${data?.title ?? "none"}`}</p>;
    }
    const ui = (auth: Record<string, unknown>) =>
      tree(
        auth,
        <>
          <TaskQuery id={board.t1} seen={seen} />
          <Row />
        </>,
      );
    const view = render(ui({ principal: as(board.ada) }));
    await screen.findByText("get T1/SECRET");
    await screen.findByText("row T1");
    const key = qd.task.get.key({ id: board.t1 });
    const result = queryClient.getQueryData(key);
    const entry = queryClient.getQueryData(entityKey("taskService", board.t1));
    const socket = grabbed.connection?.socket.id;
    const before = seen.length;
    view.rerender(ui({ principal: as(board.ada), refreshed: true }));
    await until(
      () => grabbed.connection?.socket.id !== socket && callsOf(grabbed.sent, "get").length === 2,
    );
    await until(() => framesOf(grabbed.sent, "qd:sub").length === 2);
    await tick(200);
    expect(callsOf(grabbed.sent, "get")[1]).toHaveProperty("v");
    expect(queryClient.getQueryData(key)).toBe(result);
    expect(queryClient.getQueryData(entityKey("taskService", board.t1))).toBe(entry);
    // No render after the switch went without the data: nothing was emptied.
    expect(seen.slice(before).filter(([, shown]) => !shown.includes("SECRET"))).toEqual([]);
    expect(screen.getByText("row T1")).toBeTruthy();
  });
});
