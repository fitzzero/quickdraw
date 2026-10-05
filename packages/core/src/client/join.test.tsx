// `useJoin` (finding F4.3) against a real server: a joining call runs on the
// first hello, again after every reconnect (a new socket is in no room) and
// for a new input, never on a re-render; a refusal shows until the next
// hello; `enabled: false` joins nothing. Then the same hook on a mock client.

import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { QuickdrawError, defineContract, mutation, query } from "../index";
import { initQuickdraw, type Principal } from "../server/index";
import { createMockClient, renderWithQuickdraw } from "../testing/client";
import { createTestApp, type TestApp } from "../testing/index";
import { createQuickdrawClient } from "./createClient";
import { useJoin, type JoinMember } from "./join";

const server = initQuickdraw<{ principal: Principal }>();
const roomInput = z.object({ room: z.string() });

const lobby = defineContract("lobbyService", {
  methods: {
    enter: mutation({ input: roomInput, output: z.object({ room: z.string(), n: z.number() }) }),
    look: query({ input: roomInput, output: z.number() }),
  },
});

/** Every join the server ran, in order. */
const entered: { readonly userId: string; readonly room: string }[] = [];
/** Rooms `enter` refuses with CONFLICT. */
const full = new Set<string>();

const lobbyService = server.defineService(lobby, {
  methods: {
    enter: {
      access: "authenticated",
      handler: ({ input, ctx }) => {
        if (full.has(input.room)) {
          throw new QuickdrawError("CONFLICT", "The room is full");
        }
        ctx.rooms.join(input.room);
        entered.push({ userId: ctx.principal.userId, room: input.room });
        return { room: input.room, n: entered.length };
      },
    },
    look: {
      access: "authenticated",
      handler: ({ input, ctx }) => {
        ctx.rooms.join(input.room);
        entered.push({ userId: ctx.principal.userId, room: input.room });
        return entered.length;
      },
    },
  },
});

const qd = createQuickdrawClient({ lobby });
const apps: TestApp[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => await app.close()));
  entered.length = 0;
  full.clear();
});

async function start() {
  const app = await createTestApp({ services: [lobbyService] });
  apps.push(app as unknown as TestApp);
  return app;
}

const ada = { userId: "ada" };

function Lobby<Output>({
  member,
  room,
  enabled,
}: {
  readonly member: JoinMember<{ room: string }, Output>;
  readonly room: string;
  readonly enabled?: boolean;
}) {
  const joined = useJoin(member, { room }, { enabled });
  const shown = joined.data === undefined ? "-" : JSON.stringify(joined.data);
  return (
    <>
      <p>{`${joined.status} ${shown} ${joined.error?.code ?? "ok"}`}</p>
      <button type="button" onClick={joined.retry}>
        retry
      </button>
    </>
  );
}

describe("useJoin", () => {
  it("joins on the first hello and again after every reconnect, never on a re-render", async () => {
    const app = await start();
    const view = await renderWithQuickdraw(<Lobby member={qd.lobby.enter} room="r1" />, {
      app,
      as: ada,
      client: qd,
    });
    const shown = within(view.container);
    await shown.findByText('joined {"room":"r1","n":1} ok');
    expect(await app.server.presence.users("r1")).toEqual(["ada"]);
    // A new input object of the same value, twice: no call.
    view.rerender(<Lobby member={qd.lobby.enter} room="r1" />);
    view.rerender(<Lobby member={qd.lobby.enter} room="r1" />);
    await view.disconnect();
    // No socket to be in a room with: idle, the last answer kept.
    await shown.findByText('idle {"room":"r1","n":1} ok');
    await waitFor(async () => {
      expect(await app.server.presence.users("r1")).toEqual([]);
    });
    await view.reconnect();
    await shown.findByText('joined {"room":"r1","n":2} ok');
    expect(await app.server.presence.users("r1")).toEqual(["ada"]);
    expect(entered).toEqual([
      { userId: "ada", room: "r1" },
      { userId: "ada", room: "r1" },
    ]);
  });

  it("joins again when the input changes by value, and takes a query member too", async () => {
    const app = await start();
    const view = await renderWithQuickdraw(<Lobby member={qd.lobby.look} room="r1" />, {
      app,
      as: ada,
      client: qd,
    });
    const shown = within(view.container);
    await shown.findByText("joined 1 ok");
    view.rerender(<Lobby member={qd.lobby.look} room="r2" />);
    await shown.findByText("joined 2 ok");
    expect(entered.map(({ room }) => room)).toEqual(["r1", "r2"]);
  });

  it("shows the call's refusal until the next hello", async () => {
    const app = await start();
    const view = await renderWithQuickdraw(<Lobby member={qd.lobby.enter} room="qd:nope" />, {
      app,
      as: ada,
      client: qd,
    });
    await within(view.container).findByText("error - VALIDATION");
    expect(entered).toEqual([]);
  });

  it("runs the call again on retry(), after a refusal (finding F6.3)", async () => {
    full.add("r1");
    const app = await start();
    const view = await renderWithQuickdraw(<Lobby member={qd.lobby.enter} room="r1" />, {
      app,
      as: ada,
      client: qd,
    });
    const shown = within(view.container);
    await shown.findByText("error - CONFLICT");
    // The refusal stands: nothing joins until the user retries.
    full.delete("r1");
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    });
    expect(shown.getByText("error - CONFLICT")).toBeTruthy();
    fireEvent.click(shown.getByText("retry"));
    await shown.findByText('joined {"room":"r1","n":1} ok');
    expect(await app.server.presence.users("r1")).toEqual(["ada"]);
    // While disabled or with no socket, retry() does nothing: the next hello joins anyway.
    view.rerender(<Lobby member={qd.lobby.enter} room="r1" enabled={false} />);
    fireEvent.click(shown.getByText("retry"));
    await view.disconnect();
    view.rerender(<Lobby member={qd.lobby.enter} room="r1" />);
    fireEvent.click(shown.getByText("retry"));
    expect(entered).toHaveLength(1);
    await view.reconnect();
    await shown.findByText('joined {"room":"r1","n":2} ok');
  });

  it("joins nothing while disabled, and at once when enabled", async () => {
    const app = await start();
    const view = await renderWithQuickdraw(
      <Lobby member={qd.lobby.enter} room="r1" enabled={false} />,
      { app, as: ada, client: qd },
    );
    const shown = within(view.container);
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    });
    expect(shown.getByText("idle - ok")).toBeTruthy();
    expect(entered).toEqual([]);
    view.rerender(<Lobby member={qd.lobby.enter} room="r1" enabled />);
    await shown.findByText('joined {"room":"r1","n":1} ok');
  });

  it("runs a mock client's member under its provider, once per known session", async () => {
    const mock = createMockClient({ lobby });
    mock.lobby.enter.mockResolvedValue({ room: "r1", n: 7 });
    const view = render(<Lobby member={mock.lobby.enter} room="r1" />, {
      wrapper: mock.$Provider,
    });
    await within(view.container).findByText('joined {"room":"r1","n":7} ok');
    expect(mock.lobby.enter.calls).toEqual([{ room: "r1" }]);
    act(() => {
      mock.$session({ userId: "bo" });
    });
    await waitFor(() => {
      expect(mock.lobby.enter.calls).toHaveLength(2);
    });
  });
});
