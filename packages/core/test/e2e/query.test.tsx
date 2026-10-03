// End to end (RFC 0003 sections 11.2, 11.3 and 17): queries through the
// real hooks against the real server. A query loads its data or the
// server's refusal, and a watched query is read once on its first mount
// (its read waits for the topic's join) and once more after a write by
// another user changes the topic, however many hooks read it.

import { describe, expect, it } from "vitest";
import { createQuickdrawClient } from "../../src/client/index";
import { renderWithQuickdraw } from "../../src/testing/client";
import { as, e2eApp, projectContract, taskContract, tick } from "../fixtures/app";

const e2e = e2eApp();
const qd = createQuickdrawClient({ task: taskContract, project: projectContract });

function Title({ id }: { readonly id: string }) {
  const { data, error } = qd.task.get.useQuery({ id });
  if (error !== null) {
    return <p>{`refused ${error.code}`}</p>;
  }
  return <p>{data === undefined ? "loading" : `title ${data.title}`}</p>;
}

function Count({ projectId }: { readonly projectId: string }) {
  const { data } = qd.task.countOnBoard.useQuery({ projectId });
  return <p>{data === undefined ? "counting" : `${data} tasks`}</p>;
}

describe("useQuery", () => {
  it("loads a query's data from the server", async () => {
    const { app, records } = await e2e.start();
    const board = e2e.board();
    const view = await renderWithQuickdraw(<Title id={board.t1} />, {
      app,
      as: as(board.cy),
      client: qd,
    });
    expect(view.getByText("loading")).toBeTruthy();
    await view.findByText("title T1");
    expect(records.map((record) => [record.method, record.transport, record.outcome])).toEqual([
      ["get", "socket", "ok"],
    ]);
  });

  it("shows the server's refusal to a user who may not read the row", async () => {
    const { app } = await e2e.start();
    const board = e2e.board();
    const view = await renderWithQuickdraw(<Title id={board.t1} />, {
      app,
      as: as(board.ed),
      client: qd,
    });
    await view.findByText("refused FORBIDDEN");
  });
});

describe("a watched query", () => {
  it("is read once on its first mount, and once more after another user's write", async () => {
    const { app, records } = await e2e.start();
    const board = e2e.board();
    const reads = (): number =>
      records.filter((record) => record.method === "countOnBoard" && record.transport === "socket")
        .length;
    const view = await renderWithQuickdraw(
      <>
        <Count projectId={board.p1} />
        <Count projectId={board.p1} />
      </>,
      { app, as: as(board.ada), client: qd },
    );
    await view.findAllByText("1 tasks");
    await tick(300);
    expect(reads()).toBe(1);

    app.frames.clear();
    await app.as(as(board.bo)).taskService.create({ projectId: board.p1, title: "By Bo" });
    await view.findAllByText("2 tasks");
    // The coordinator's window and any second frame would show by now.
    await tick(400);
    expect(reads()).toBe(2);
    expect(app.frames({ event: "qd:changed", userId: board.ada }).map((f) => f.data)).toEqual([
      { s: "taskService", topic: `board:${board.p1}`, rev: expect.any(Number) },
    ]);
  });

  it("is not told of writes to another project's board", async () => {
    const { app, records } = await e2e.start();
    const board = e2e.board();
    const view = await renderWithQuickdraw(<Count projectId={board.p1} />, {
      app,
      as: as(board.ada),
      client: qd,
    });
    await view.findByText("1 tasks");
    app.frames.clear();
    await app.as(as(board.ada)).taskService.create({ projectId: board.p3, title: "Elsewhere" });
    await tick(400);
    expect(app.frames({ event: "qd:changed", userId: board.ada })).toEqual([]);
    expect(records.filter((record) => record.method === "countOnBoard")).toHaveLength(1);
    expect(view.getByText("1 tasks")).toBeTruthy();
  });
});
