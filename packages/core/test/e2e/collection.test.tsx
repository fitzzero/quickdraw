// End to end (RFC 0003 sections 7 and 11.5): live collection scopes through
// `useCollection`. Tasks added, changed, reordered, moved to another project
// and removed by other users appear in each board in the contract's order,
// and a view over the board's index follows its members live.

import { waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createQuickdrawClient } from "../../src/client/index";
import { renderWithQuickdraw } from "../../src/testing/client";
import { inCluster } from "../cluster/mode";
import { as, e2eApp, projectContract, taskContract } from "../fixtures/app";

const e2e = e2eApp();
const qd = createQuickdrawClient({ task: taskContract, project: projectContract });

function Board({ name, projectId, mine }: { name: string; projectId: string; mine?: boolean }) {
  const { items, totalCount, isLoading } = qd.task.board.useCollection(
    projectId,
    mine === true ? { view: "mine" } : {},
  );
  return (
    <section aria-label={name}>
      <p>{isLoading ? "loading" : `total ${String(totalCount)}`}</p>
      <ul>
        {items.map((item) => (
          <li key={item.id}>{item.title}</li>
        ))}
      </ul>
    </section>
  );
}

/** The titles board `name` shows, in order. */
function titlesOn(container: HTMLElement, name: string): string[] {
  const section = within(container).getByRole("region", { name });
  return within(section)
    .queryAllByRole("listitem")
    .map((item) => item.textContent ?? "");
}

describe("useCollection", () => {
  it("shows tasks added, changed, reordered, moved between projects and removed", async () => {
    const { app } = await e2e.start();
    const board = e2e.board();
    const view = await renderWithQuickdraw(
      <>
        <Board name="P1" projectId={board.p1} />
        <Board name="P3" projectId={board.p3} />
      </>,
      { app, as: as(board.ada), client: qd },
    );
    const titles = (name: string): string[] => titlesOn(view.container, name);
    await view.findByText("total 1");
    await view.findByText("total 0");
    expect([titles("P1"), titles("P3")]).toEqual([["T1"], []]);
    app.frames.clear();
    const bo = app.as(as(board.bo)).taskService;

    const second = await bo.create({ projectId: board.p1, title: "Second", ordinal: 5 });
    await view.findByText("Second");
    expect(titles("P1")).toEqual(["T1", "Second"]);

    await bo.rename({ id: board.t1, title: "First" });
    await view.findByText("First");
    expect(titles("P1")).toEqual(["First", "Second"]);

    await bo.reorder({ id: second.id, ordinal: -1 });
    await waitFor(() => expect(titles("P1")).toEqual(["Second", "First"]));

    await app.as(as(board.ada)).taskService.move({ id: board.t1, projectId: board.p3 });
    await waitFor(() => expect(titles("P3")).toEqual(["First"]));
    expect(titles("P1")).toEqual(["Second"]);

    await bo.remove({ id: second.id });
    await waitFor(() => expect(titles("P1")).toEqual([]));
    expect(titles("P3")).toEqual(["First"]);

    const deltas = app
      .frames({ event: "qd:c", userId: board.ada })
      .flatMap((frame) =>
        frame.data.deltas.map((delta) => [frame.data.scope === board.p1 ? "P1" : "P3", delta.t]),
      );
    // Behind a cluster adapter a change in place goes out whole.
    const inPlace = inCluster() ? "updated" : "patched";
    expect(deltas).toEqual([
      ["P1", "added"],
      ["P1", inPlace],
      ["P1", inPlace],
      ["P1", "removed"],
      ["P3", "added"],
      ["P1", "removed"],
    ]);
  });

  it("filters a view over the index live, for the viewer", async () => {
    const { app } = await e2e.start();
    const board = e2e.board();
    const view = await renderWithQuickdraw(
      <>
        <Board name="all" projectId={board.p1} />
        <Board name="mine" projectId={board.p1} mine />
      </>,
      { app, as: as(board.bo), client: qd },
    );
    const titles = (name: string): string[] => titlesOn(view.container, name);
    await view.findAllByText("total 1");
    expect([titles("all"), titles("mine")]).toEqual([["T1"], []]);
    const ada = app.as(as(board.ada)).taskService;

    await ada.assign({ id: board.t1, assigneeId: board.bo });
    await waitFor(() => expect(titles("mine")).toEqual(["T1"]));
    await ada.create({ projectId: board.p1, title: "Unassigned", ordinal: 1 });
    await waitFor(() => expect(titles("all")).toEqual(["T1", "Unassigned"]));
    expect(titles("mine")).toEqual(["T1"]);

    await ada.assign({ id: board.t1, assigneeId: board.cy });
    await waitFor(() => expect(titles("mine")).toEqual([]));
    expect(titles("all")).toEqual(["T1", "Unassigned"]);
  });
});
