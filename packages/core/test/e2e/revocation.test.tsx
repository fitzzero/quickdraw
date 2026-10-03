// End to end (RFC 0003 section 4.4): access revoked while a user watches.
// When the owner removes a member from a project, the member's live row,
// board and watched query show the refusal, and the server sends the member
// nothing more about the project while the others keep getting updates.

import { within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createQuickdrawClient } from "../../src/client/index";
import { renderWithQuickdraw } from "../../src/testing/client";
import { as, e2eApp, projectContract, taskContract } from "../fixtures/app";

const e2e = e2eApp();
const qd = createQuickdrawClient({ task: taskContract, project: projectContract });

function Member({ id, projectId }: { readonly id: string; readonly projectId: string }) {
  const row = qd.task.useEntity(id);
  const scope = qd.task.board.useCollection(projectId);
  const count = qd.task.countOnBoard.useQuery({ projectId });
  return (
    <>
      <p>{row.error === null ? `row ${row.data?.title ?? "-"}` : `row ${row.error.code}`}</p>
      <p>
        {scope.error === null
          ? `board ${scope.items.map((item) => item.title).join(",")}`
          : `board ${scope.error.code}`}
      </p>
      <p>{count.error === null ? `count ${String(count.data)}` : `count ${count.error.code}`}</p>
    </>
  );
}

describe("revoking a member", () => {
  it("surfaces the refusal on every live view, and stops the member's updates", async () => {
    const { app } = await e2e.start();
    const board = e2e.board();
    const ui = <Member id={board.t1} projectId={board.p1} />;
    const cy = await renderWithQuickdraw(ui, { app, as: as(board.cy), client: qd });
    const bo = await renderWithQuickdraw(ui, { app, as: as(board.bo), client: qd });
    for (const view of [cy, bo]) {
      const shown = within(view.container);
      await shown.findByText("row T1");
      await shown.findByText("board T1");
      await shown.findByText("count 1");
    }
    app.frames.clear();

    await app
      .as(as(board.ada))
      .projectService.removeMember({ projectId: board.p1, userId: board.cy });
    const removed = within(cy.container);
    await removed.findByText("row FORBIDDEN");
    await removed.findByText("board FORBIDDEN");
    await removed.findByText("count FORBIDDEN");
    const revoked = app.frames({ event: "qd:revoked", userId: board.cy });
    expect(revoked).toHaveLength(2);
    expect(revoked.map((frame) => frame.data)).toEqual(
      expect.arrayContaining([
        { kind: "entity", reason: "access", s: "taskService", id: board.t1 },
        {
          kind: "collection",
          reason: "access",
          s: "taskService",
          c: "board",
          scope: board.p1,
        },
      ]),
    );
    expect(app.frames({ event: "qd:revoked", userId: board.bo })).toEqual([]);

    app.frames.clear();
    await app.as(as(board.ada)).taskService.rename({ id: board.t1, title: "After" });
    await within(bo.container).findByText("row After");
    await within(bo.container).findByText("board After");
    await app.frames.waitFor({ event: "qd:changed", userId: board.bo });
    expect(app.frames({ userId: board.cy })).toEqual([]);
    expect(removed.getByText("row FORBIDDEN")).toBeTruthy();
    expect(removed.getByText("board FORBIDDEN")).toBeTruthy();
    expect(removed.getByText("count FORBIDDEN")).toBeTruthy();
  });
});
