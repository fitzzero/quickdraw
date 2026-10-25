// End to end (RFC 0003 sections 7.3 and 11.5): a dropped connection that
// comes back. After `disconnect()` and `reconnect()` the client keeps what
// it showed, catches up on what changed meanwhile, and resumes a board from
// the server's recent-delta buffer when the buffer covers the outage, with
// no snapshot read; when nobody kept the scope's buffer, it reads a snapshot.
// A call made while the socket is down waits for the new socket's hello, and
// goes out then, in order. A session the server ends is another matter (the
// 5.1 audit's CLIENT-1): the client forgets the user and everything it
// cached.

import { within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createQuickdrawClient } from "../../src/client/index";
import { renderWithQuickdraw } from "../../src/testing/client";
import { inCluster } from "../cluster/mode";
import { as, e2eApp, projectContract, taskContract } from "../fixtures/app";

const e2e = e2eApp();
const qd = createQuickdrawClient({ task: taskContract, project: projectContract });

function Board({ id, projectId }: { readonly id: string; readonly projectId: string }) {
  const row = qd.task.useEntity(id);
  const scope = qd.task.board.useCollection(projectId);
  return (
    <>
      <p>{`row ${row.data?.title ?? "-"}`}</p>
      <p>{`board ${scope.items.map((item) => item.title).join(",")}`}</p>
    </>
  );
}

/** This test's app, and a way to render T1 and P1's board as a user, loaded. */
async function boards() {
  const started = await e2e.start();
  const board = e2e.board();
  const renderAs = async (userId: string) => {
    const view = await renderWithQuickdraw(<Board id={board.t1} projectId={board.p1} />, {
      app: started.app,
      as: as(userId),
      client: qd,
    });
    await within(view.container).findByText("row T1");
    await within(view.container).findByText("board T1");
    return { view, shown: within(view.container) };
  };
  // The storage reads of a scope's pages, which carry `take`: a snapshot.
  const pageReads = (): number =>
    started.reads.filter((read) => read.model === "task" && read.args.take !== undefined).length;
  return { ...started, board, renderAs, pageReads };
}

describe("disconnect() and reconnect()", () => {
  it("resume a board from the server's buffer, without a snapshot, and catch up on the row", async () => {
    const { app, board, renderAs, pageReads } = await boards();
    const ada = await renderAs(board.ada);
    // Bo stays connected, so the server keeps P1's board deltas meanwhile.
    const bo = await renderAs(board.bo);
    await ada.view.disconnect();
    expect(ada.view.connection.getState()).toMatchObject({
      status: "connecting",
      reconnecting: true,
    });
    const writer = app.as(as(board.bo)).taskService;
    await writer.rename({ id: board.t1, title: "While away" });
    await writer.create({ projectId: board.p1, title: "New", ordinal: 1 });
    await bo.shown.findByText("board While away,New");
    expect(ada.shown.getByText("board T1")).toBeTruthy();
    const before = pageReads();

    await ada.view.reconnect();
    await ada.shown.findByText("board While away,New");
    await ada.shown.findByText("row While away");
    if (inCluster()) {
      // Behind a cluster adapter a resume reads a page: a process's buffer sees its own flushes only.
      expect(pageReads()).toBeGreaterThan(before);
    } else {
      expect(pageReads()).toBe(before);
    }
    expect(ada.view.connection.getState()).toMatchObject({
      status: "connected",
      reconnecting: false,
    });
  });

  it("read a snapshot when nobody kept the scope's buffer", async () => {
    const { app, board, renderAs, pageReads } = await boards();
    const ada = await renderAs(board.ada);
    await ada.view.disconnect();
    await app.as(as(board.bo)).taskService.rename({ id: board.t1, title: "While away" });
    const before = pageReads();

    await ada.view.reconnect();
    await ada.shown.findByText("board While away");
    await ada.shown.findByText("row While away");
    expect(pageReads()).toBeGreaterThan(before);
  });

  it("send the calls made meanwhile once the new socket's hello is in, in order, beside the reads that resume the row and the board", async () => {
    const { board, renderAs } = await boards();
    const ada = await renderAs(board.ada);
    await ada.view.disconnect();
    const { socket } = ada.view.connection;
    const sent: string[] = [];
    socket.onAnyOutgoing((event: string, frame: unknown) => {
      const method = (frame as { readonly m?: unknown } | undefined)?.m;
      sent.push(event === "qd:call" ? `qd:call ${String(method)}` : event);
    });
    // Heard before the connection's own listener: marks where the new socket's hello came in.
    socket.onAny((event: string) => {
      if (event === "qd:hello") {
        sent.push("(hello)");
      }
    });
    // Made while the socket is down: held, never in Socket.IO's send buffer.
    const renames = [
      qd.task.rename.call({ id: board.t1, title: "Held A" }),
      qd.task.rename.call({ id: board.t1, title: "Held B" }),
    ];
    expect(socket.sendBuffer).toEqual([]);

    await ada.view.reconnect();
    await Promise.all(renames);
    await ada.shown.findByText("row Held B");
    await ada.shown.findByText("board Held B");
    // The renames went once the hello was in, in the order they were made; the reads that
    // resume the live data go from the connect on, beside them, and both catch up.
    const calls = sent.filter((event) => event.startsWith("qd:call"));
    expect(calls).toEqual(["qd:call rename", "qd:call rename"]);
    expect(sent.indexOf("(hello)")).toBeLessThan(sent.indexOf("qd:call rename"));
    expect(sent).toEqual(expect.arrayContaining(["qd:sub", "qd:col:sub"]));
    const stored = await e2e.prisma().task.findUnique({ where: { id: board.t1 } });
    expect(stored?.title).toBe("Held B");
  });
});

describe("a session the server ends", () => {
  it("leaves nothing of the user's data on screen or in the cache", async () => {
    const { app, board, renderAs } = await boards();
    const ada = await renderAs(board.ada);
    app.server.access.disconnectUser(board.ada);
    await ada.shown.findByText("row -");
    await ada.shown.findByText("board");
    expect(ada.view.connection.getState()).toMatchObject({ status: "disconnected", hello: null });
    const cached = ada.view.queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data);
    // A collection's entry holds its items in Maps, which JSON leaves empty unless written out.
    const written = JSON.stringify(cached, (_key, value: unknown) =>
      value instanceof Map || value instanceof Set ? [...value] : value,
    );
    expect(written).not.toContain("T1");
  });
});
