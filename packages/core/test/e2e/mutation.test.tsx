// End to end (RFC 0003 section 11.4): an optimistic mutation through the
// real hooks. The user's edit shows on the live row and on the board's card
// before the server answers, settles to the server's data once the server
// has written it, and rolls back when the server refuses it.

import { fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createQuickdrawClient } from "../../src/client/index";
import { renderWithQuickdraw } from "../../src/testing/client";
import { as, e2eApp, projectContract, taskContract } from "../fixtures/app";

const e2e = e2eApp();
const qd = createQuickdrawClient({ task: taskContract, project: projectContract });

function Task({ id, projectId }: { readonly id: string; readonly projectId: string }) {
  const { data } = qd.task.useEntity(id);
  const { items } = qd.task.board.useCollection(projectId);
  const rename = qd.task.rename.useMutation();
  return (
    <>
      <p>{`row ${data?.title ?? "loading"}`}</p>
      <ul>
        {items.map((item) => (
          <li key={item.id}>{`card ${item.title}`}</li>
        ))}
      </ul>
      <button type="button" onClick={() => rename.mutate({ id, title: "Renamed" })}>
        rename
      </button>
      <button type="button" onClick={() => rename.mutate({ id, title: "conflict" })}>
        take a title in use
      </button>
      <p>{rename.error === null ? `mutation ${rename.status}` : `refused ${rename.error.code}`}</p>
    </>
  );
}

/** Bo's view of T1 and P1's board, loaded. */
async function renderTask() {
  const started = await e2e.start();
  const board = e2e.board();
  const view = await renderWithQuickdraw(<Task id={board.t1} projectId={board.p1} />, {
    app: started.app,
    as: as(board.bo),
    client: qd,
  });
  await view.findByText("row T1");
  await view.findByText("card T1");
  started.app.frames.clear();
  return { ...started, board, view };
}

async function storedTitle(id: string): Promise<string | undefined> {
  return (await e2e.prisma().task.findUnique({ where: { id } }))?.title;
}

describe("an optimistic mutation", () => {
  it("shows the user's edit before the server answers, then settles to the server's data", async () => {
    const { app, gate, board, view } = await renderTask();
    const release = gate.hold();
    fireEvent.click(view.getByText("rename"));
    await view.findByText("row Renamed");
    expect(view.getByText("card Renamed")).toBeTruthy();
    // Nothing is written yet: the server holds the call at the gate.
    expect(await storedTitle(board.t1)).toBe("T1");
    expect(app.frames({ event: "qd:e", userId: board.bo })).toEqual([]);

    release();
    await view.findByText("mutation success");
    const frame = await app.frames.waitFor({ event: "qd:e", userId: board.bo });
    expect(frame.data).toMatchObject({ s: "taskService", id: board.t1, d: { title: "Renamed" } });
    expect(await storedTitle(board.t1)).toBe("Renamed");
    // The server's data has caught up, so the edit no longer covers it.
    await app.as(as(board.ada)).taskService.rename({ id: board.t1, title: "By Ada" });
    await view.findByText("row By Ada");
    expect(view.getByText("card By Ada")).toBeTruthy();
  });

  it("rolls the edit back when the server refuses it", async () => {
    const { app, gate, board, view } = await renderTask();
    const release = gate.hold();
    fireEvent.click(view.getByText("take a title in use"));
    await view.findByText("row conflict");
    expect(view.getByText("card conflict")).toBeTruthy();

    release();
    await view.findByText("refused CONFLICT");
    expect(view.getByText("row T1")).toBeTruthy();
    expect(view.getByText("card T1")).toBeTruthy();
    expect(await storedTitle(board.t1)).toBe("T1");
    expect(app.frames({ event: "qd:e", userId: board.bo })).toEqual([]);
  });
});
