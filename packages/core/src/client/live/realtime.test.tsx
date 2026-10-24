// The realtime hooks (RFC 0003 section 12.5) against a real server:
// `useStream` shows the seed, then appends what is pushed after it, trimmed
// to `max`, shares one subscription between components and subscribes again
// after a reconnect; `useChannel` sends what the server's handler receives,
// every message of a burst, and drops one only while the connection is
// backed up; `useEvent` hears the typed events of the rooms its socket is
// in; `usePresence` follows who joins and leaves an app room. Then the same
// members on a mock client.

import { act, render, waitFor, within } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineContract, mutation, QuickdrawError } from "../../index";
import { FAST_BACKLOG_BYTES } from "../../protocol/version";
import { initQuickdraw, type Principal } from "../../server/index";
import { createMockClient, renderWithQuickdraw } from "../../testing/client";
import { createTestApp, type TestApp } from "../../testing/index";
import { outgoing } from "../__tests__/fixtures";
import { createQuickdrawClient } from "../createClient";
import { useQuickdraw } from "../provider";
import { usePresence } from "./usePresence";

const server = initQuickdraw<{ principal: Principal }>();
const roomInput = z.object({ room: z.string() });

const room = defineContract("roomService", {
  methods: {
    enter: mutation({ input: roomInput, output: z.boolean() }),
    exit: mutation({ input: roomInput, output: z.boolean() }),
    shout: mutation({ input: z.object({ room: z.string(), text: z.string() }), output: z.null() }),
  },
  streams: {
    ticker: { item: z.object({ n: z.number() }), scope: "room", seed: 3, access: "authenticated" },
    news: { item: z.string(), seed: 2, access: "public" },
    secret: { item: z.string(), access: { service: "Admin" } },
  },
  channels: {
    cursor: { payload: z.object({ x: z.number(), y: z.number().default(0) }) },
    /** A rate no burst here reaches: what the client sends is what the handler gets. */
    aim: { payload: z.object({ n: z.number() }), ratePerSecond: 10_000, burst: 10_000 },
  },
  events: { shouted: { payload: z.object({ text: z.string() }) } },
});

const cursors: { readonly userId: string; readonly x: number; readonly y: number }[] = [];
const aims: number[] = [];

const roomService = server.defineService(room, {
  methods: {
    enter: { access: "authenticated", handler: ({ input, ctx }) => ctx.rooms.join(input.room) },
    exit: { access: "authenticated", handler: ({ input, ctx }) => ctx.rooms.leave(input.room) },
    shout: {
      access: "authenticated",
      handler: ({ input, ctx }) => {
        ctx.rooms.emit(input.room, room, "shouted", { text: input.text });
        return null;
      },
    },
  },
  channels: {
    // Any signed-in user may send a cursor here: said on the service, so it does not warn.
    cursor: {
      access: "authenticated",
      handler: (payload, ctx) => {
        cursors.push({ userId: ctx.principal.userId, ...payload });
      },
    },
    aim: {
      access: "authenticated",
      handler: (payload) => {
        aims.push(payload.n);
      },
    },
  },
});

const qd = createQuickdrawClient({ room });
const apps: TestApp[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => await app.close()));
  cursors.length = 0;
  aims.length = 0;
});

async function start() {
  const app = await createTestApp({ services: [roomService] });
  apps.push(app as unknown as TestApp);
  return app;
}

const ada = { userId: "ada" };
const bo = { userId: "bo" };

function Ticker({ scope, max }: { readonly scope: string | null; readonly max?: number }) {
  const { items, isLoading, error } = qd.room.ticker.useStream(scope, { max });
  if (error !== null) {
    return <p>{`refused ${error.code}`}</p>;
  }
  return <p>{isLoading ? "loading" : `ticks [${items.map((item) => item.n).join(",")}]`}</p>;
}

function News() {
  const { items, isLoading } = qd.room.news.useStream();
  return <p>{isLoading ? "loading news" : `news [${items.join(",")}]`}</p>;
}

function Secret() {
  const { error, isLoading } = qd.room.secret.useStream();
  return <p>{isLoading ? "loading secret" : `secret ${error?.code ?? "open"}`}</p>;
}

function Cursor() {
  const { send, isReady } = qd.room.cursor.useChannel();
  return (
    <button type="button" onClick={() => send({ x: 3 })}>
      {isReady ? "ready" : "waiting"}
    </button>
  );
}

/** Sends three cursors in one effect once its socket is ready: in one tick. */
function Burst() {
  const { send, isReady } = qd.room.cursor.useChannel();
  const sent = useRef(false);
  useEffect(() => {
    if (isReady && !sent.current) {
      sent.current = true;
      for (const x of [1, 2, 3]) {
        send({ x });
      }
    }
  }, [isReady, send]);
  return <p>{isReady ? "ready" : "waiting"}</p>;
}

/** Sends `count` aims in one click: in one tick. */
function Aim({ count }: { readonly count: number }) {
  const { send, isReady } = qd.room.aim.useChannel();
  return (
    <button
      type="button"
      onClick={() => {
        for (let n = 0; n < count; n += 1) {
          send({ n });
        }
      }}
    >
      {isReady ? "ready" : "waiting"}
    </button>
  );
}

function Shouts() {
  const [texts, setTexts] = useState<string[]>([]);
  qd.room.shouted.useEvent((payload) => {
    setTexts((held) => [...held, payload.text]);
  });
  return <p>{`shouts [${texts.join(",")}]`}</p>;
}

function Lobby() {
  const users = usePresence("lobby");
  return <p>{`present [${[...users].sort().join(",")}]`}</p>;
}

describe("useStream", () => {
  it("shows the seed, then every item pushed after it, keeping the latest max", async () => {
    const app = await start();
    const ticker = app.server.stream(room, "ticker");
    ticker.push("lobby", { n: 1 });
    ticker.push("lobby", { n: 2 });
    const view = await renderWithQuickdraw(<Ticker scope="lobby" max={3} />, {
      app,
      as: ada,
      client: qd,
    });
    await view.findByText("ticks [1,2]");
    for (const n of [3, 4, 5]) {
      ticker.push("lobby", { n });
    }
    await view.findByText("ticks [3,4,5]");
    ticker.push("elsewhere", { n: 9 });
    ticker.push("lobby", { n: 6 });
    await view.findByText("ticks [4,5,6]");
  });

  it("shares one subscription between components, each showing its own max", async () => {
    const app = await start();
    const received: string[] = [];
    app.server.io.on("connection", (socket) => {
      socket.onAny((event: string) => {
        received.push(event);
      });
    });
    const ticker = app.server.stream(room, "ticker");
    const view = await renderWithQuickdraw(
      <>
        <section aria-label="short">
          <Ticker scope="lobby" max={1} />
        </section>
        <section aria-label="long">
          <Ticker scope="lobby" max={4} />
        </section>
      </>,
      { app, as: ada, client: qd },
    );
    await within(view.getByRole("region", { name: "long" })).findByText("ticks []");
    for (const n of [1, 2, 3]) {
      ticker.push("lobby", { n });
    }
    await within(view.getByRole("region", { name: "long" })).findByText("ticks [1,2,3]");
    within(view.getByRole("region", { name: "short" })).getByText("ticks [3]");
    expect(received.filter((event) => event === "qd:stream:sub")).toHaveLength(1);
  });

  it("takes no scope for a global stream, holds nothing for a null scope, and shows a refusal", async () => {
    const app = await start();
    app.server.stream(room, "news").push("first");
    const view = await renderWithQuickdraw(
      <>
        <News />
        <Secret />
        <Ticker scope={null} />
      </>,
      { app, as: ada, client: qd },
    );
    await view.findByText("news [first]");
    await view.findByText("secret FORBIDDEN");
    view.getByText("ticks []");
    app.server.stream(room, "news").push("second");
    await view.findByText("news [first,second]");
  });

  it("shows FORBIDDEN and nothing further when the server revokes the feed", async () => {
    const app = await createTestApp({
      services: [roomService],
      auth: { loadServiceAccess: () => ({}) },
    });
    apps.push(app as unknown as TestApp);
    const secret = app.server.stream(room, "secret");
    function Feed() {
      const { items, isLoading, error } = qd.room.secret.useStream();
      if (error !== null) {
        return <p>{`refused ${error.code} [${items.join(",")}]`}</p>;
      }
      return <p>{isLoading ? "loading" : `secrets [${items.join(",")}]`}</p>;
    }
    const view = await renderWithQuickdraw(<Feed />, {
      app,
      as: { userId: "ada", serviceAccess: { roomService: "Admin" } },
      client: qd,
    });
    await view.findByText("secrets []");
    secret.push("one");
    await view.findByText("secrets [one]");
    // The grant is gone: the server revokes the feed.
    await app.server.access.refresh("ada");
    await view.findByText("refused FORBIDDEN []");
    secret.push("two");
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    view.getByText("refused FORBIDDEN []");
  });

  it("shows the next user on the connection none of the last user's items", async () => {
    const app = await createTestApp({
      services: [roomService],
      auth: { loadServiceAccess: () => ({}) },
    });
    apps.push(app as unknown as TestApp);
    const secret = app.server.stream(room, "secret");
    const shown: (readonly [string | null, string])[] = [];
    function Feed() {
      const { userId } = useQuickdraw();
      const { items, isLoading, error } = qd.room.secret.useStream();
      let text = isLoading ? "loading" : `secrets [${items.join(",")}]`;
      if (error !== null) {
        text = `refused ${error.code} [${items.join(",")}]`;
      }
      shown.push([userId, text]);
      return <p>{text}</p>;
    }
    const view = await renderWithQuickdraw(<p>start</p>, {
      app,
      as: { userId: "ada", serviceAccess: { roomService: "Admin" } },
      client: qd,
    });
    await view.findByText("start");
    // Mounted after the provider's first commit, so the provider made the cache session before
    // the live data asked for it: one session, whose hello for Bo makes the feed forget Ada's items.
    view.rerender(<Feed />);
    await view.findByText("secrets []");
    secret.push("ada-only");
    await view.findByText("secrets [ada-only]");
    await act(async () => {
      view.connection.setAuth({ principal: { userId: "bo" } });
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    await view.findByText("refused FORBIDDEN []");
    const toBo = shown.filter(([userId]) => userId === "bo").map(([, text]) => text);
    expect(toBo).toContain("refused FORBIDDEN []");
    expect(toBo.filter((text) => text.includes("ada-only"))).toEqual([]);
  });

  it("subscribes again after a reconnect, showing the seed it missed", async () => {
    const app = await start();
    const ticker = app.server.stream(room, "ticker");
    const view = await renderWithQuickdraw(<Ticker scope="lobby" />, {
      app,
      as: ada,
      client: qd,
    });
    await view.findByText("ticks []");
    ticker.push("lobby", { n: 1 });
    await view.findByText("ticks [1]");
    await view.disconnect();
    ticker.push("lobby", { n: 2 });
    await view.reconnect();
    await view.findByText("ticks [1,2]");
    ticker.push("lobby", { n: 3 });
    await view.findByText("ticks [1,2,3]");
  });

  it("unsubscribes once the last component holding the feed unmounts", async () => {
    const app = await start();
    const view = await renderWithQuickdraw(<Ticker scope="lobby" />, { app, as: ada, client: qd });
    await view.findByText("ticks []");
    const sent = outgoing(view.connection);
    view.rerender(<p>gone</p>);
    await waitFor(() => {
      expect(sent).toContainEqual([
        "qd:stream:unsub",
        { s: "roomService", stream: "ticker", scope: "lobby" },
      ]);
    });
  });
});

describe("useChannel", () => {
  it("is ready once the server said hello, and sends what the handler receives", async () => {
    const app = await start();
    const view = await renderWithQuickdraw(<Cursor />, { app, as: ada, client: qd });
    const button = await view.findByText("ready");
    act(() => {
      button.click();
    });
    await waitFor(() => {
      expect(cursors).toEqual([{ userId: "ada", x: 3, y: 0 }]);
    });
  });

  it("sends every message of a burst: three in one effect all reach the handler", async () => {
    const app = await start();
    const view = await renderWithQuickdraw(<Burst />, { app, as: ada, client: qd });
    await view.findByText("ready");
    // Socket.IO's volatile flag kept the first: the transport was busy with it for the tick.
    await waitFor(() => {
      expect(cursors.map((cursor) => cursor.x)).toEqual([1, 2, 3]);
    });
  });

  it("drops a message while the connection is backed up, and sends the next once it is not", async () => {
    const app = await start();
    const view = await renderWithQuickdraw(<Cursor />, { app, as: ada, client: qd });
    const button = await view.findByText("ready");
    const sent = outgoing(view.connection);
    const channel = () => sent.filter(([event]) => event === "qd:ch");
    // More than 32 KiB unsent in the WebSocket: backed up.
    const { transport } = view.connection.socket.io.engine as unknown as {
      readonly transport: { readonly ws: object };
    };
    Object.defineProperty(transport.ws, "bufferedAmount", {
      configurable: true,
      value: FAST_BACKLOG_BYTES + 1,
    });
    act(() => {
      button.click();
    });
    expect(channel()).toEqual([]);
    Reflect.deleteProperty(transport.ws, "bufferedAmount");
    act(() => {
      button.click();
    });
    expect(channel()).toEqual([["qd:ch", ["roomService", "cursor", { x: 3 }]]]);
    await waitFor(() => {
      expect(cursors).toEqual([{ userId: "ada", x: 3, y: 0 }]);
    });
  });

  it("sends 64 of a burst of 100 in one tick: the engine holds the one it is writing until it drains", async () => {
    const app = await start();
    const view = await renderWithQuickdraw(<Aim count={100} />, { app, as: ada, client: qd });
    const button = await view.findByText("ready");
    act(() => {
      button.click();
    });
    await waitFor(() => {
      expect(aims).toHaveLength(64);
    });
    // The other 36 were dropped, not held: a round trip later the handler has the first 64 alone.
    await act(async () => {
      await qd.room.enter.call({ room: "lobby" });
    });
    expect(aims).toEqual(Array.from({ length: 64 }, (_, n) => n));
  });
});

describe("useEvent", () => {
  it("hears the typed events of the rooms its socket is in", async () => {
    const app = await start();
    const view = await renderWithQuickdraw(<Shouts />, { app, as: ada, client: qd });
    await act(async () => {
      await qd.room.enter.call({ room: "lobby" });
    });
    const other = await app.connect(bo);
    await other.call.roomService.shout({ room: "lobby", text: "hi" });
    await other.call.roomService.shout({ room: "elsewhere", text: "unheard" });
    await other.call.roomService.shout({ room: "lobby", text: "again" });
    await view.findByText("shouts [hi,again]");
  });
});

describe("usePresence", () => {
  it("follows who joins and leaves an app room the socket is in", async () => {
    const app = await start();
    const view = await renderWithQuickdraw(<Lobby />, { app, as: ada, client: qd });
    view.getByText("present []");
    await act(async () => {
      await qd.room.enter.call({ room: "lobby" });
    });
    await view.findByText("present [ada]");
    const other = await app.connect(bo);
    await other.call.roomService.enter({ room: "lobby" });
    await view.findByText("present [ada,bo]");
    other.close();
    await view.findByText("present [ada]");
    await act(async () => {
      await qd.room.exit.call({ room: "lobby" });
    });
    await view.findByText("present []");
  });
});

describe("frames from a later revision of protocol 5", () => {
  it("reads the fields and elements it knows, and ignores the ones appended after them", async () => {
    const app = await start();
    // A newer server: a field more in the hello.
    app.server.io.use((socket, next) => {
      const emit = socket.emit.bind(socket) as (event: string, ...args: unknown[]) => boolean;
      (socket as unknown as { emit: typeof emit }).emit = (event, ...args) =>
        event === "qd:hello"
          ? emit(event, { ...(args[0] as object), future: { x: 1 } }, ...args.slice(1))
          : emit(event, ...args);
      next();
    });
    const view = await renderWithQuickdraw(
      <>
        <Ticker scope="lobby" />
        <Shouts />
        <Lobby />
      </>,
      { app, as: ada, client: qd },
    );
    await view.findByText("ticks []");
    await act(async () => {
      await qd.room.enter.call({ room: "lobby" });
    });
    await view.findByText("present [ada]");
    act(() => {
      const { io } = app.server;
      io.emit("qd:stream", ["roomService", "ticker", "lobby", { n: 7 }, "future", { y: 2 }]);
      io.emit("qd:event", ["roomService", "shouted", { text: "three" }]);
      io.emit("qd:event", ["roomService", "shouted", { text: "four" }, "future"]);
      io.emit("qd:presence", { room: "lobby", users: ["ada", "cy"], future: 1 });
      io.emit("qd:changed", { s: "roomService", topic: "service", rev: 1, future: 2 });
      io.emit("qd:revoked", {
        kind: "entity",
        reason: "access",
        s: "roomService",
        id: "x",
        future: 3,
      });
    });
    await view.findByText("ticks [7]");
    await view.findByText("shouts [three,four]");
    await view.findByText("present [ada,cy]");
    // The session goes on: a push and a call after those frames.
    app.server.stream(room, "ticker").push("lobby", { n: 8 });
    await view.findByText("ticks [7,8]");
    await act(async () => {
      expect(await qd.room.exit.call({ room: "lobby" })).toBe(true);
    });
  });
});

describe("the realtime members of a mock client", () => {
  it("show the items and errors the test sets, record what is sent, and emit events", async () => {
    const mock = createMockClient({ room });
    function MockTicker() {
      const { items, isLoading, error } = mock.room.ticker.useStream("lobby", { max: 2 });
      const news = mock.room.news.useStream();
      return (
        <p>
          {`ticker [${isLoading ? "loading" : items.map((item) => item.n).join(",")}] error [${error?.code ?? ""}] news [${news.items.join(",")}]`}
        </p>
      );
    }
    function MockShouts() {
      const [texts, setTexts] = useState<string[]>([]);
      mock.room.shouted.useEvent((payload) => {
        setTexts((held) => [...held, payload.text]);
      });
      const { send, isReady } = mock.room.cursor.useChannel();
      return (
        <button type="button" onClick={() => send({ x: 1 })}>
          {`ready ${String(isReady)} heard [${texts.join(",")}]`}
        </button>
      );
    }
    const view = render(
      <>
        <MockTicker />
        <MockShouts />
      </>,
    );
    view.getByText("ticker [loading] error [] news []");
    act(() => {
      mock.room.ticker.mockItems("lobby", [{ n: 1 }, { n: 2 }, { n: 3 }]);
      mock.room.news.mockItems(["latest"]);
    });
    await view.findByText("ticker [2,3] error [] news [latest]");
    act(() => {
      mock.room.ticker.mockError("lobby", new QuickdrawError("FORBIDDEN", "no"));
    });
    await view.findByText("ticker [] error [FORBIDDEN] news [latest]");
    act(() => {
      mock.room.shouted.mockEmit({ text: "hey" });
    });
    const button = await view.findByText("ready true heard [hey]");
    act(() => {
      button.click();
    });
    expect(mock.room.cursor.sent).toEqual([{ x: 1 }]);
    mock.$reset();
    expect(mock.room.cursor.sent).toEqual([]);
  });
});
