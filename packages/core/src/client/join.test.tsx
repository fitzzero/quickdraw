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
import { useQuickdraw } from "./provider";

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

  it("drops a join answered after the session changed: never the last user's data or onJoined", async () => {
    const mock = createMockClient({ lobby });
    const answers: ((value: { room: string; n: number }) => void)[] = [];
    mock.lobby.enter.mockImplementation(
      () =>
        new Promise((resolve) => {
          answers.push(resolve);
        }),
    );
    const joined: unknown[] = [];
    function Watched() {
      const join = useJoin(
        mock.lobby.enter,
        { room: "r1" },
        { onJoined: (data) => joined.push(data) },
      );
      return <p>{`${join.status} ${join.data === undefined ? "-" : JSON.stringify(join.data)}`}</p>;
    }
    const view = render(<Watched />, { wrapper: mock.$Provider });
    await waitFor(() => {
      expect(answers).toHaveLength(1);
    });
    // New credentials while the first join is in flight: the hello is gone before the old
    // socket closes, and its answer arrives then.
    act(() => {
      mock.$session({ userId: "bo", isKnown: false, isConnected: false });
    });
    act(() => {
      answers[0]?.({ room: "r1", n: 1 });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(joined).toEqual([]);
    // The new user's hello joins again.
    act(() => {
      mock.$session({ userId: "bo" });
    });
    await waitFor(() => {
      expect(answers).toHaveLength(2);
    });
    act(() => {
      answers[1]?.({ room: "r1", n: 2 });
    });
    await within(view.container).findByText('joined {"room":"r1","n":2}');
    expect(joined).toEqual([{ room: "r1", n: 2 }]);
  });

  /** A mock whose `enter` answers when the test says, and what each render of a join showed. */
  function heldJoins() {
    const mock = createMockClient({ lobby }, { session: { userId: "ada" } });
    const calls: {
      readonly resolve: (value: { room: string; n: number }) => void;
      readonly reject: (error: unknown) => void;
    }[] = [];
    mock.lobby.enter.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          calls.push({ resolve, reject });
        }),
    );
    const renders: string[] = [];
    function Watched() {
      const { userId } = useQuickdraw();
      const join = useJoin(mock.lobby.enter, { room: "r1" });
      const data = join.data === undefined ? "-" : JSON.stringify(join.data);
      const shown = `${userId ?? "-"} ${join.status} ${data} ${join.error?.code ?? "ok"}`;
      renders.push(shown);
      return <p>{shown}</p>;
    }
    const view = render(<Watched />, { wrapper: mock.$Provider });
    const last = async (prefix: string): Promise<void> => {
      await waitFor(() => {
        expect(renders.at(-1)?.startsWith(prefix), JSON.stringify(renders)).toBe(true);
      });
    };
    return { mock, calls, renders, shown: within(view.container), last };
  }

  it("shows what a join returned to no other user: not while their hello is awaited, nor after", async () => {
    const { mock, calls, renders, shown, last } = heldJoins();
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    act(() => {
      calls[0]?.resolve({ room: "r1", n: 1 });
    });
    await shown.findByText('ada joined {"room":"r1","n":1} ok');
    // New credentials: the hello is gone until the server names the next user.
    const switched = renders.length;
    act(() => {
      mock.$session({ userId: "bo", isKnown: false, isConnected: false });
    });
    await last("- idle ");
    const waiting = renders.slice(switched);
    expect(
      waiting.filter((text) => text.includes('"n":1')),
      JSON.stringify(waiting),
    ).toEqual([]);
    // Bo's hello joins again, and the server refuses Bo.
    act(() => {
      mock.$session({ userId: "bo" });
    });
    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    act(() => {
      calls[1]?.reject(new QuickdrawError("FORBIDDEN", "Bo may not enter"));
    });
    await last("bo error ");
    const toBo = renders.slice(switched).filter((text) => text.startsWith("bo "));
    expect(
      toBo.filter((text) => text.includes('"n":1')),
      JSON.stringify(toBo),
    ).toEqual([]);
    expect(toBo.at(-1)).toBe("bo error - FORBIDDEN");
  });

  it("shows the same user's answer again once their new credentials' hello names them", async () => {
    const { mock, calls, renders, shown, last } = heldJoins();
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    act(() => {
      calls[0]?.resolve({ room: "r1", n: 1 });
    });
    await shown.findByText('ada joined {"room":"r1","n":1} ok');
    // A refreshed token: nobody is known until the hello, which names Ada again.
    const refreshed = renders.length;
    act(() => {
      mock.$session({ userId: "ada", isKnown: false, isConnected: false });
    });
    await last("- idle ");
    const waiting = renders.slice(refreshed);
    expect(
      waiting.filter((text) => text.includes('"n":1')),
      JSON.stringify(waiting),
    ).toEqual([]);
    act(() => {
      mock.$session({ userId: "ada" });
    });
    await shown.findByText('ada joining {"room":"r1","n":1} ok');
    act(() => {
      calls[1]?.resolve({ room: "r1", n: 2 });
    });
    await shown.findByText('ada joined {"room":"r1","n":2} ok');
  });

  it("shows the next user none of the last user's answer, even while it joins nothing", async () => {
    const mock = createMockClient({ lobby }, { session: { userId: "ada" } });
    mock.lobby.enter.mockResolvedValue({ room: "r1", n: 1 });
    const renders: string[] = [];
    function Gated({ enabled }: { readonly enabled: boolean }) {
      const { userId } = useQuickdraw();
      const join = useJoin(mock.lobby.enter, { room: "r1" }, { enabled });
      const data = join.data === undefined ? "-" : JSON.stringify(join.data);
      const shown = `${userId ?? "-"} ${join.status} ${data}`;
      renders.push(shown);
      return <p>{shown}</p>;
    }
    const view = render(<Gated enabled />, { wrapper: mock.$Provider });
    const shown = within(view.container);
    await shown.findByText('ada joined {"room":"r1","n":1}');
    // Disabled, it joins no more, and keeps the answer for the user it ran as.
    view.rerender(<Gated enabled={false} />);
    await shown.findByText('ada idle {"room":"r1","n":1}');
    const switched = renders.length;
    act(() => {
      mock.$session({ userId: "bo", isKnown: false, isConnected: false });
    });
    act(() => {
      mock.$session({ userId: "bo" });
    });
    await shown.findByText(/^bo idle /);
    const toBo = renders.slice(switched).filter((text) => text.startsWith("bo "));
    expect(
      toBo.filter((text) => text.includes('"n":1')),
      JSON.stringify(toBo),
    ).toEqual([]);
    expect(mock.lobby.enter.calls).toHaveLength(1);
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
