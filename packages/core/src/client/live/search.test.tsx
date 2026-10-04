// `qd.<service>.<search>.useSearch` (RFC 0003 section 12.2) against a real
// server on PGlite with tracked writes (`../../server/kits/search/__tests__/
// fixture.ts`): typing is debounced into one search, a search that typing
// replaced while it was on its way is cancelled on the server, the last
// results stay shown meanwhile, and a result follows another user's rename
// while a `useCollection` holds its scope, without searching again.

import { act, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { tick } from "../../server/__tests__/fixtures";
import {
  addTasks,
  as,
  searchApp,
  searchContract,
} from "../../server/kits/search/__tests__/fixture";
import { renderWithQuickdraw } from "../../testing/client";
import { createQuickdrawClient } from "../createClient";
import { outgoing, until } from "../__tests__/fixtures";

const kit = searchApp();
const qd = createQuickdrawClient({ task: searchContract });

interface ResultsProps {
  readonly q: string;
  readonly scope?: string;
  readonly debounceMs?: number;
}

function Results({ q, scope, debounceMs }: ResultsProps) {
  const { items, isLoading, isSearching } = qd.task.search.useSearch(q, { scope, debounceMs });
  const status = isLoading ? "loading" : isSearching ? "searching" : "idle";
  return (
    <section aria-label="results">
      <p>{status}</p>
      <ul>
        {items.map((item) => (
          <li key={item.id}>{item.title}</li>
        ))}
      </ul>
    </section>
  );
}

function Board({ projectId }: { readonly projectId: string }) {
  const { totalCount } = qd.task.board.useCollection(projectId);
  return <p>{`board ${String(totalCount)}`}</p>;
}

/** The titles the results show, in order. */
function titlesOf(container: HTMLElement): string[] {
  const section = within(container).getByRole("region", { name: "results" });
  return within(section)
    .queryAllByRole("listitem")
    .map((item) => item.textContent ?? "");
}

/** The inputs of the searches a connection sent, in order. */
function searchesSent(sent: readonly unknown[][]): unknown[] {
  return sent
    .filter(([event, frame]) => event === "qd:call" && (frame as { m?: unknown }).m === "search")
    .map(([, frame]) => (frame as { i: unknown }).i);
}

/** Holds every search's strategy until opened. */
function createGate() {
  let open = (): void => undefined;
  let opened = Promise.resolve();
  return {
    hold(): void {
      opened = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    open: () => {
      open();
    },
    wait: () => opened,
  };
}

describe("useSearch", () => {
  it("sends one search for characters typed within the debounce, and none below minLength", async () => {
    const { app, records } = await kit.start();
    const board = kit.board();
    await addTasks(kit.harness().prisma, board.p1, [1, 2]);
    const view = await renderWithQuickdraw(<Results q="" debounceMs={100} />, {
      app,
      as: as(board.ada),
      client: qd,
    });
    const sent = outgoing(view.connection);
    view.rerender(<Results q="t" debounceMs={100} />);
    await tick(150);
    expect(searchesSent(sent)).toEqual([]);
    view.rerender(<Results q="ta" debounceMs={100} />);
    view.rerender(<Results q="tas" debounceMs={100} />);
    view.rerender(<Results q="task" debounceMs={100} />);
    expect(view.getByText("loading")).toBeTruthy();
    await waitFor(() => expect(titlesOf(view.container)).toEqual(["Task 1", "Task 2"]));
    expect(searchesSent(sent)).toEqual([{ q: "task" }]);
    expect(records.map((record) => [record.method, record.outcome])).toEqual([["search", "ok"]]);
  });

  it("cancels the searches typing replaced while they were on their way", async () => {
    const gate = createGate();
    const { app, records } = await kit.start({
      strategy: {
        where: async (q) => {
          await gate.wait();
          return { title: { contains: q, mode: "insensitive" } };
        },
      },
    });
    const board = kit.board();
    await addTasks(kit.harness().prisma, board.p1, [1, 2]);
    gate.hold();
    const view = await renderWithQuickdraw(<Results q="" debounceMs={0} />, {
      app,
      as: as(board.ada),
      client: qd,
    });
    const sent = outgoing(view.connection);
    view.rerender(<Results q="ta" debounceMs={0} />);
    await until(() => searchesSent(sent).length === 1);
    view.rerender(<Results q="tas" debounceMs={0} />);
    await until(() => searchesSent(sent).length === 2);
    view.rerender(<Results q="task" debounceMs={0} />);
    await until(() => searchesSent(sent).length === 3);
    // The server answered the two cancels at once, while their strategies still waited.
    await until(() => records.length === 2);
    await act(async () => {
      gate.open();
      await until(() => records.length === 3);
    });
    await waitFor(() => expect(titlesOf(view.container)).toEqual(["Task 1", "Task 2"]));
    expect(records.map((record) => record.outcome)).toEqual(["CANCELLED", "CANCELLED", "ok"]);
    const cancelled = sent.filter(([event]) => event === "qd:cancel").map(([, frame]) => frame);
    const calls = sent.filter(([event]) => event === "qd:call").map(([, frame]) => frame);
    expect(cancelled).toEqual([
      { id: (calls[0] as { id: number }).id },
      { id: (calls[1] as { id: number }).id },
    ]);
  });

  it("keeps the last results shown while the next search is on its way", async () => {
    const gate = createGate();
    const { app } = await kit.start({
      strategy: {
        where: async (q) => {
          await gate.wait();
          return { title: { contains: q, mode: "insensitive" } };
        },
      },
    });
    const board = kit.board();
    await addTasks(kit.harness().prisma, board.p1, [1, 2]);
    const view = await renderWithQuickdraw(<Results q="task" debounceMs={0} />, {
      app,
      as: as(board.ada),
      client: qd,
    });
    await waitFor(() => expect(titlesOf(view.container)).toEqual(["Task 1", "Task 2"]));
    gate.hold();
    view.rerender(<Results q="task 2" debounceMs={0} />);
    await view.findByText("searching");
    expect(titlesOf(view.container)).toEqual(["Task 1", "Task 2"]);
    await act(async () => {
      gate.open();
      await tick(0);
    });
    await waitFor(() => expect(titlesOf(view.container)).toEqual(["Task 2"]));
    expect(view.getByText("idle")).toBeTruthy();
    // Clearing the query shows nothing at once.
    view.rerender(<Results q="" debounceMs={0} />);
    expect(titlesOf(view.container)).toEqual([]);
  });

  it("shows another user's rename of a result while the scope's collection is held, without searching again", async () => {
    const { app, records } = await kit.start();
    const board = kit.board();
    const harness = kit.harness();
    // The board loads in pages of 2: T1 and Task 1. Task 3 is a member it has not loaded.
    const [, , third = ""] = await addTasks(harness.prisma, board.p1, [1, 2, 3]);
    const view = await renderWithQuickdraw(
      <>
        <Board projectId={board.p1} />
        <Results q="task 3" scope={board.p1} debounceMs={0} />
      </>,
      { app, as: as(board.cy), client: qd },
    );
    await view.findByText("board 4");
    await waitFor(() => expect(titlesOf(view.container)).toEqual(["Task 3"]));
    await act(async () => {
      await app.server.dispatcher.run(
        async () =>
          await harness.db.task.update({ where: { id: third }, data: { title: "Renamed" } }),
      );
    });
    await waitFor(() => expect(titlesOf(view.container)).toEqual(["Renamed"]));
    expect(records.filter((record) => record.method === "search")).toHaveLength(1);
    const deltas = app
      .frames({ event: "qd:c", userId: board.cy })
      .flatMap((frame) => frame.data.deltas.map((delta) => delta.t));
    expect(deltas).toEqual(["patched"]);
  });

  it("keeps the title a result was found with when no hook holds its scope", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const harness = kit.harness();
    const [, , third = ""] = await addTasks(harness.prisma, board.p1, [1, 2, 3]);
    const view = await renderWithQuickdraw(<Results q="task 3" scope={board.p1} debounceMs={0} />, {
      app,
      as: as(board.cy),
      client: qd,
    });
    await waitFor(() => expect(titlesOf(view.container)).toEqual(["Task 3"]));
    await act(async () => {
      await app.server.dispatcher.run(
        async () =>
          await harness.db.task.update({ where: { id: third }, data: { title: "Renamed" } }),
      );
      await tick(200);
    });
    expect(titlesOf(view.container)).toEqual(["Task 3"]);
    expect(app.frames({ event: "qd:c" })).toEqual([]);
  });
});
