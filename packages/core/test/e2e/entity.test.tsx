// End to end (RFC 0003 sections 6 and 11.5): a live row through `useEntity`.
// It follows writes made by other users as the server sends them, shows the
// row's removal, and a field above the viewer's access level never reaches
// the viewer: not in the first answer, not in any frame.

import { within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createQuickdrawClient } from "../../src/client/index";
import { renderWithQuickdraw } from "../../src/testing/client";
import { inCluster } from "../cluster/mode";
import { as, e2eApp, projectContract, taskContract } from "../fixtures/app";

const e2e = e2eApp();
const qd = createQuickdrawClient({ task: taskContract, project: projectContract });

function Row({ id }: { readonly id: string }) {
  const { data, isLoading, isRemoved, error } = qd.task.useEntity(id);
  if (error !== null) {
    return <p>{`refused ${error.code}`}</p>;
  }
  if (data === undefined) {
    return <p>{isRemoved ? "removed" : `loading ${String(isLoading)}`}</p>;
  }
  return (
    <>
      <p>{`title ${data.title}`}</p>
      <p>{`notes ${data.notes ?? "none"}`}</p>
      <p>{`fields ${Object.keys(data).sort().join(",")}`}</p>
    </>
  );
}

/** Whether `frame` (a `qd:e` frame's data) carries a `notes` field. */
function carriesNotes(frame: unknown): boolean {
  const data = (frame as { readonly d?: unknown }).d;
  return typeof data === "object" && data !== null && "notes" in data;
}

describe("useEntity", () => {
  it("follows another user's writes, and shows the row's removal", async () => {
    const { app } = await e2e.start();
    const board = e2e.board();
    const view = await renderWithQuickdraw(<Row id={board.t1} />, {
      app,
      as: as(board.cy),
      client: qd,
    });
    expect(view.getByText("loading true")).toBeTruthy();
    await view.findByText("title T1");
    app.frames.clear();

    await app.as(as(board.bo)).taskService.rename({ id: board.t1, title: "By Bo" });
    await view.findByText("title By Bo");
    // Behind a cluster adapter a change in place goes out whole.
    const d = inCluster() ? expect.objectContaining({ title: "By Bo" }) : { title: "By Bo" };
    expect(app.frames({ event: "qd:e", userId: board.cy }).map((frame) => frame.data)).toEqual([
      expect.objectContaining({ s: "taskService", id: board.t1, d }),
    ]);

    await app.as(as(board.ada)).taskService.remove({ id: board.t1 });
    await view.findByText("removed");
  });

  it("never sends the viewer a field above their access level", async () => {
    const { app } = await e2e.start();
    const board = e2e.board();
    const owner = await renderWithQuickdraw(<Row id={board.t1} />, {
      app,
      as: as(board.ada),
      client: qd,
    });
    const reader = await renderWithQuickdraw(<Row id={board.t1} />, {
      app,
      as: as(board.cy),
      client: qd,
    });
    await within(owner.container).findByText("title T1");
    await within(reader.container).findByText("title T1");
    // The reader's first answer has no notes field at all; the owner's has one.
    expect(within(owner.container).getByText(/^fields /).textContent).toContain("notes");
    expect(within(reader.container).getByText(/^fields /).textContent).not.toContain("notes");

    await app.as(as(board.ada)).taskService.setNotes({ id: board.t1, notes: "secret" });
    await within(owner.container).findByText("notes secret");
    await app.as(as(board.bo)).taskService.rename({ id: board.t1, title: "Renamed" });
    await within(reader.container).findByText("title Renamed");
    await within(owner.container).findByText("title Renamed");

    expect(within(reader.container).getByText("notes none")).toBeTruthy();
    const toReader = app.frames({ event: "qd:e", userId: board.cy });
    const toOwner = app.frames({ event: "qd:e", userId: board.ada });
    expect(toReader).not.toEqual([]);
    expect(toReader.filter((frame) => carriesNotes(frame.data))).toEqual([]);
    // Behind a cluster adapter the rename goes out whole too, so the owner's copy carries notes.
    expect(toOwner.filter((frame) => carriesNotes(frame.data))).toHaveLength(inCluster() ? 2 : 1);
  });
});
