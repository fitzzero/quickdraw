// End to end (RFC 0003 section 11.4): an optimistic mutation through the
// real hooks. The user's edit shows on the live row and on the board's card
// before the server answers, settles to the server's data once the server
// has written it, and rolls back when the server refuses it. A create shows
// its new card at once (`cache.addItem`), flagged pending, and becomes the
// server's own card with no gap and no second copy, or goes when refused.

import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createQuickdrawClient, overlaysOf, type CollectionEntry } from "../../src/client/index";
import { renderWithQuickdraw } from "../../src/testing/client";
import { collectionKey } from "../../src/utils/index";
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

/** P1's board as Bo sees it, with a create that adds its card at once. */
function Board({ projectId, seen }: { readonly projectId: string; readonly seen: string[][] }) {
  const { items, pending } = qd.task.board.useCollection(projectId);
  const create = qd.task.create.useMutation({
    optimistic: (input, cache) =>
      cache.addItem("board", input.projectId, {
        projectId: input.projectId,
        title: input.title,
        status: "open",
        ordinal: input.ordinal ?? 0,
        assigneeId: null,
      }),
  });
  const shown = items.map((item) => `${pending.has(item.id) ? "sending" : "card"} ${item.title}`);
  seen.push(shown);
  return (
    <>
      <ul>
        {shown.map((text, index) => (
          <li key={items[index]?.id}>{text}</li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => create.mutate({ projectId, title: "Added", ordinal: 99 })}
      >
        add
      </button>
      <button
        type="button"
        onClick={() => create.mutate({ projectId, title: "conflict", ordinal: 99 })}
      >
        add a title in use
      </button>
      <p>{create.error === null ? `create ${create.status}` : `refused ${create.error.code}`}</p>
    </>
  );
}

async function renderBoard() {
  const started = await e2e.start();
  const board = e2e.board();
  const seen: string[][] = [];
  const view = await renderWithQuickdraw(<Board projectId={board.p1} seen={seen} />, {
    app: started.app,
    as: as(board.bo),
    client: qd,
  });
  await view.findByText("card T1");
  started.app.frames.clear();
  return { ...started, board, view, seen };
}

async function titlesOf(projectId: string): Promise<string[]> {
  const rows = await e2e.prisma().task.findMany({ where: { projectId }, orderBy: { id: "asc" } });
  return rows.map((row) => row.title);
}

describe("an optimistic create", () => {
  it("shows its card at once, pending, then settles into the server's card with no gap and no copy", async () => {
    const { app, gate, board, view, seen } = await renderBoard();
    const before = await titlesOf(board.p1);
    const release = gate.hold();
    fireEvent.click(view.getByText("add"));
    await view.findByText("sending Added");
    // Nothing is written yet: the server holds the call at the gate.
    expect(await titlesOf(board.p1)).toEqual(before);
    const shownAt = seen.length - 1;

    release();
    await view.findByText("create success");
    await app.frames.waitFor({ event: "qd:c", userId: board.bo });
    await view.findByText("card Added");
    const after = await titlesOf(board.p1);
    expect(after).toHaveLength(before.length + 1);
    expect(after.filter((title) => title === "Added")).toHaveLength(1);
    // From the first render that showed it, every render showed the new card exactly once, last.
    for (const shown of seen.slice(shownAt)) {
      expect(shown.filter((text) => text.endsWith(" Added"))).toHaveLength(1);
      expect(shown.at(-1)).toMatch(/ Added$/);
    }
    // The card shown now is the server's: its frames keep it current.
    const created = await e2e.prisma().task.findFirst({ where: { title: "Added" } });
    await app.as(as(board.ada)).taskService.rename({ id: created?.id ?? "", title: "Renamed" });
    await view.findByText("card Renamed");
    expect(view.queryByText(/Added/)).toBeNull();
  });

  it("removes the card when the server refuses the create", async () => {
    const { app, gate, board, view } = await renderBoard();
    const before = await titlesOf(board.p1);
    const release = gate.hold();
    fireEvent.click(view.getByText("add a title in use"));
    await view.findByText("sending conflict");

    release();
    await view.findByText("refused CONFLICT");
    expect(view.queryByText(/conflict$/)).toBeNull();
    expect(view.getByText("card T1")).toBeTruthy();
    expect(await titlesOf(board.p1)).toEqual(before);
    expect(app.frames({ event: "qd:c", userId: board.bo })).toEqual([]);
  });
});

/** P1's board with a create whose card stays when refused (`onRefused: "keep"`), to retry or dismiss. */
function KeptBoard({ projectId }: { readonly projectId: string }) {
  const { items, pending, refused } = qd.task.board.useCollection(projectId);
  const create = qd.task.create.useMutation({
    optimistic: (input, cache) =>
      cache.addItem(
        "board",
        input.projectId,
        {
          projectId: input.projectId,
          title: input.title,
          status: "open",
          ordinal: input.ordinal ?? 0,
          assigneeId: null,
        },
        { onRefused: "keep" },
      ),
  });
  return (
    <>
      <ul>
        {items.map((item) => (
          <li key={item.id}>{`${pending.has(item.id) ? "sending" : "card"} ${item.title}`}</li>
        ))}
      </ul>
      <ul>
        {refused.map(({ item, error, retry, dismiss }) => (
          <li key={item.id}>
            {`failed ${item.title} ${error.code}`}
            <button type="button" onClick={() => void retry()}>
              {`retry ${item.title}`}
            </button>
            <button type="button" onClick={dismiss}>
              {`dismiss ${item.title}`}
            </button>
          </li>
        ))}
      </ul>
      {["First", "Second"].map((title, index) => (
        <button
          key={title}
          type="button"
          onClick={() => create.mutate({ projectId, title, ordinal: 99 + index })}
        >
          {`add ${title}`}
        </button>
      ))}
    </>
  );
}

/** Each render's mutation state and refused items, and the hook's settled calls (finding F8.3). */
interface StateLog {
  readonly renders: { readonly isPending: boolean; readonly refused: number }[];
  settled: number;
}

/** P1's board whose create's state and refused items are logged at every render. */
function LoggedBoard({ projectId, log }: { readonly projectId: string; readonly log: StateLog }) {
  const { refused } = qd.task.board.useCollection(projectId);
  const create = qd.task.create.useMutation({
    optimistic: (input, cache) =>
      cache.addItem(
        "board",
        input.projectId,
        {
          projectId: input.projectId,
          title: input.title,
          status: "open",
          ordinal: 99,
          assigneeId: null,
        },
        { onRefused: "keep" },
      ),
    onSettled: () => {
      log.settled += 1;
    },
  });
  log.renders.push({ isPending: create.isPending, refused: refused.length });
  return (
    <>
      <p>{`mutation ${create.status}`}</p>
      {refused.map(({ item, retry }) => (
        <button key={item.id} type="button" onClick={() => void retry()}>
          {`retry ${item.title}`}
        </button>
      ))}
      <button type="button" onClick={() => create.mutate({ projectId, title: "First" })}>
        add First
      </button>
    </>
  );
}

describe("an optimistic create with onRefused: keep (finding F6.4)", () => {
  it("shows a refused card in the render that shows the error, and retries through the mutation (finding F8.3)", async () => {
    const { app } = await e2e.start();
    const board = e2e.board();
    const log: StateLog = { renders: [], settled: 0 };
    const view = await renderWithQuickdraw(<LoggedBoard projectId={board.p1} log={log} />, {
      app,
      as: as(board.di),
      client: qd,
    });
    await view.findByText("mutation idle");
    fireEvent.click(view.getByText("add First"));
    await view.findByText("retry First");
    await view.findByText("mutation error");
    // Never refused while the mutation still showed as pending.
    expect(log.renders.filter((render) => render.refused > 0 && render.isPending)).toEqual([]);
    expect(log.settled).toBe(1);
    // A retry is the hook's own mutation: pending again, and its callbacks run.
    await e2e.prisma().project.update({
      where: { id: board.p1 },
      data: { acl: [{ userId: board.di, level: "Moderate" }] },
    });
    const before = log.renders.length;
    fireEvent.click(view.getByText("retry First"));
    await view.findByText("mutation success");
    expect(log.renders.slice(before).some((render) => render.isPending)).toBe(true);
    expect(log.settled).toBe(2);
    expect(view.queryByText("retry First")).toBeNull();
  });

  it("keeps the refused card out of the items with its error, until it is dismissed or sent again", async () => {
    const { app } = await e2e.start();
    const board = e2e.board();
    // Di reads P1 through its access list, and may not create there.
    const view = await renderWithQuickdraw(<KeptBoard projectId={board.p1} />, {
      app,
      as: as(board.di),
      client: qd,
    });
    await view.findByText("card T1");
    fireEvent.click(view.getByText("add First"));
    await view.findByText("failed First FORBIDDEN");
    fireEvent.click(view.getByText("add Second"));
    await view.findByText("failed Second FORBIDDEN");
    expect(view.queryByText(/^(card|sending) (First|Second)$/)).toBeNull();
    fireEvent.click(view.getByText("dismiss Second"));
    expect(view.queryByText(/failed Second/)).toBeNull();
    // Di is given Moderate on P1, and sends First again: pending, then the server's card.
    await e2e.prisma().project.update({
      where: { id: board.p1 },
      data: { acl: [{ userId: board.di, level: "Moderate" }] },
    });
    fireEvent.click(view.getByText("retry First"));
    await view.findByText("card First");
    expect(view.queryByText(/failed/)).toBeNull();
    expect(await titlesOf(board.p1)).toContain("First");
    expect(await titlesOf(board.p1)).not.toContain("Second");
  });
});

/**
 * P1's board with a create whose card carries an id the client made (which
 * the server keeps), kept when refused: what a chat's send does so that a
 * lost answer can be found again (the final review's item D).
 */
function ClientIdBoard({ projectId }: { readonly projectId: string }) {
  const { items, pending, checking, refused } = qd.task.board.useCollection(projectId);
  const create = qd.task.create.useMutation({
    optimistic: (input, cache) =>
      cache.addItem(
        "board",
        input.projectId,
        {
          ...(input.id === undefined ? {} : { id: input.id }),
          projectId: input.projectId,
          title: input.title,
          status: "open",
          ordinal: input.ordinal ?? 0,
          assigneeId: null,
        },
        { onRefused: "keep" },
      ),
  });
  const state = (id: string): string => {
    if (checking.has(id)) {
      return "checking";
    }
    return pending.has(id) ? "sending" : "card";
  };
  return (
    <>
      <ul>
        {items.map((item) => (
          <li key={item.id}>{`${state(item.id)} ${item.title}`}</li>
        ))}
      </ul>
      <ul>
        {refused.map(({ item, error, retry }) => (
          <li key={item.id}>
            {`failed ${item.title} ${error.code}`}
            <button type="button" onClick={() => void retry().catch(() => undefined)}>
              {`retry ${item.title}`}
            </button>
          </li>
        ))}
      </ul>
      {["First", "conflict"].map((title) => (
        <button
          key={title}
          type="button"
          onClick={() => create.mutate({ id: `made-${title}`, projectId, title, ordinal: 99 })}
        >
          {`add ${title}`}
        </button>
      ))}
    </>
  );
}

describe("an optimistic create whose connection drops before its answer (the final review's item D)", () => {
  /** Bo's board, a create held at the gate, and its socket's transport closed under it. */
  async function dropDuringCreate(title: string) {
    const { app, gate } = await e2e.start();
    const board = e2e.board();
    const view = await renderWithQuickdraw(<ClientIdBoard projectId={board.p1} />, {
      app,
      as: as(board.bo),
      client: qd,
    });
    await view.findByText("card T1");
    const release = gate.hold();
    fireEvent.click(view.getByText(`add ${title}`));
    await view.findByText(`sending ${title}`);
    // The handler waits at the gate; the client reconnects on its own.
    for (const socket of app.server.io.sockets.sockets.values()) {
      socket.conn.close();
    }
    // Its outcome is unknown: still shown, checking, and not offered for a retry.
    await view.findByText(`checking ${title}`);
    expect(view.queryByText(/^failed/)).toBeNull();
    return { board, view, release };
  }

  const rows = async (projectId: string, title: string) =>
    await e2e.prisma().task.findMany({ where: { projectId, title } });

  it("shows the server's one card once the scope holds its id, and nothing to retry", async () => {
    const { board, view, release } = await dropDuringCreate("First");
    // The server goes on and writes the row, after the drop.
    release();
    await waitFor(async () => {
      expect(await rows(board.p1, "First")).toHaveLength(1);
    });
    await view.findByText("card First", undefined, { timeout: 15_000 });
    await waitFor(() => {
      expect(view.queryByText(/failed First/)).toBeNull();
    });
    expect(
      view.queryAllByText(/^(card|sending|checking|failed) First/).map((node) => node.textContent),
    ).toEqual(["card First"]);
    expect(await rows(board.p1, "First")).toHaveLength(1);
  });

  it("refuses it once the scope's next load answers without it, and a retry by its id cannot write twice", async () => {
    const { board, view, release } = await dropDuringCreate("conflict");
    // The reconnect's resume answers without it: refused, with the call's error.
    await view.findByText("failed conflict INTERNAL", undefined, { timeout: 15_000 });
    // The held handler refuses it (its title is taken): nothing was written.
    release();
    fireEvent.click(view.getByText("retry conflict"));
    await view.findByText("failed conflict CONFLICT");
    expect(await rows(board.p1, "conflict")).toEqual([]);
  });

  it("shows the server's card, sent, once a reconnect's load that brings nothing new ends it (finding F11.1)", async () => {
    const { app } = await e2e.start();
    const board = e2e.board();
    const view = await renderWithQuickdraw(<ClientIdBoard projectId={board.p1} />, {
      app,
      as: as(board.bo),
      client: qd,
    });
    await view.findByText("card T1");
    // The server runs the next create and sends its frames; its answer never leaves.
    let lost = false;
    const loseAnswer = (packet: unknown[], next: () => void): void => {
      const call = packet[1] as { readonly m?: unknown } | undefined;
      if (!lost && packet[0] === "qd:call" && call?.m === "create") {
        lost = true;
        packet.splice(2, 1, () => undefined);
      }
      next();
    };
    for (const socket of app.server.io.sockets.sockets.values()) {
      socket.use(loseAnswer);
    }
    const scope = collectionKey("taskService", "board", board.p1);
    const held = () => view.queryClient.getQueryData<CollectionEntry>(scope)?.state?.byId;
    const additions = () =>
      overlaysOf(view.queryClient).view("taskService").added("board", board.p1);
    fireEvent.click(view.getByText("add First"));
    // Its frame arrived: the scope holds the server's row, and the call is still in flight.
    await waitFor(() => {
      expect(held()?.has("made-First")).toBe(true);
    });
    expect(view.getByText("sending First")).toBeTruthy();
    // The connection drops before the answer: its outcome is unknown.
    await view.disconnect();
    await view.findByText("checking First");
    // The reconnect's load brings nothing new (the frame did), and holds its id: it ends.
    await view.reconnect();
    await waitFor(() => {
      expect(additions()).toEqual([]);
    });
    // Ended in the store, so ended on screen, though the scope's state did not change.
    await view.findByText("card First");
    expect(
      view.queryAllByText(/^(card|sending|checking|failed) First/).map((node) => node.textContent),
    ).toEqual(["card First"]);
    expect(await rows(board.p1, "First")).toHaveLength(1);
  });
});
