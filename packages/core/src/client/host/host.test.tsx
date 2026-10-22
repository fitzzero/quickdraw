// Host mode from React (RFC 0003 section 12.5), against a real server: a
// player's `useChannel` sends a host-served channel to the host of its
// room, and `useStream` holds a host-served stream's feed over the same
// link, with the host's seed and then its pushes; after a reconnect (a new
// socket, joined again by `useJoin`) the link is made again and the feed's
// new seed replaces what it showed, and so after the app closes its
// connection and opens it again. The host is a client without React.

import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { alice, bob } from "../../server/__tests__/fixtures";
import {
  defineGameService,
  gameContract,
  WORLD,
  WORLD_ID,
} from "../../server/realtime/__tests__/hostGame";
import { renderWithQuickdraw } from "../../testing/client";
import { createTestApp, type TestApp } from "../../testing/index";
import { call } from "../call";
import { createQuickdrawConnection, type QuickdrawConnection } from "../connection";
import { createQuickdrawClient } from "../createClient";
import { useJoin } from "../join";
import { defineHost, type HostChannelContext } from "./host";
import { hostOf } from "./hosts";

const qd = createQuickdrawClient({ game: gameContract });

const world = { worldId: WORLD_ID };

const snapshot = (tick: number) => ({ tick, players: [] });

const apps: TestApp[] = [];
const connections: QuickdrawConnection[] = [];

afterEach(async () => {
  for (const connection of connections.splice(0)) {
    connection.close();
  }
  await Promise.all(apps.splice(0).map(async (app) => await app.close()));
});

function Player() {
  const joined = useJoin(qd.game.enter, world);
  const { items, isLoading } = qd.game.world.useStream(WORLD_ID);
  const { send } = qd.game.move.useChannel();
  return (
    <div>
      <p>{joined.isJoined ? "in the world" : "outside"}</p>
      <p>{isLoading ? "loading" : `ticks ${items.map((item) => String(item.tick)).join(",")}`}</p>
      <button type="button" onClick={() => send({ ...world, dx: 1, dy: 0 })}>
        move
      </button>
    </div>
  );
}

/** The world's host: a client without React, serving the room once a method made it the host. */
async function hostWorld(app: TestApp) {
  const moves: [unknown, HostChannelContext][] = [];
  let tick = 0;
  const worldHost = defineHost(gameContract, {
    channels: { move: (move, ctx) => moves.push([move, ctx]) },
    streams: { world: { seed: () => [snapshot(tick)] } },
  });
  const connection = createQuickdrawConnection({
    url: app.url,
    auth: { principal: alice },
    transports: ["websocket"],
  });
  connections.push(connection);
  connection.open();
  await waitFor(() => {
    expect(connection.getState().hello).not.toBe(null);
  });
  for (const method of ["enter", "host"]) {
    await call(connection, { service: "gameService", method, input: world, kind: "mutation" });
  }
  const host = worldHost.serve(connection, { room: WORLD });
  const push = (next: number): void => {
    tick = next;
    host.stream("world").push(WORLD_ID, snapshot(next));
  };
  return { moves, push };
}

describe("host mode from React", () => {
  it("sends a player's moves to the room's host, shows its world, and links again after a reconnect", async () => {
    const app = (await createTestApp({
      services: [defineGameService()],
      peers: true,
    })) as unknown as TestApp;
    apps.push(app);
    const host = await hostWorld(app);
    const view = await renderWithQuickdraw(<Player />, { app, client: qd, as: bob });
    await view.findByText("in the world");
    await view.findByText("ticks 0");
    act(() => {
      host.push(1);
    });
    await view.findByText("ticks 0,1");
    await waitFor(() => {
      fireEvent.click(view.getByText("move"));
      expect(host.moves.length).toBeGreaterThan(0);
    });
    expect(host.moves[0]).toEqual([
      { ...world, dx: 1, dy: 0 },
      { peer: { socketId: view.connection.socket.id, userId: "bob" }, room: WORLD },
    ]);
    await view.disconnect();
    act(() => {
      host.push(2);
    });
    await view.reconnect();
    await waitFor(() => {
      expect(hostOf(view.connection, WORLD)).not.toBe(null);
    });
    // The new socket's link: the host's seed is its current tick.
    await view.findByText("ticks 2");
    act(() => {
      host.push(3);
    });
    await view.findByText("ticks 2,3");
  });

  it("shows the host's world again after the app closes its connection and opens it", async () => {
    const app = (await createTestApp({
      services: [defineGameService()],
      peers: true,
    })) as unknown as TestApp;
    apps.push(app);
    const host = await hostWorld(app);
    const view = await renderWithQuickdraw(<Player />, { app, client: qd, as: bob });
    await view.findByText("ticks 0");
    act(() => {
      view.connection.close();
    });
    act(() => {
      host.push(1);
    });
    act(() => {
      view.connection.open();
    });
    // The new socket joins again, links to the host, and its seed is the current tick.
    await view.findByText("ticks 1");
    act(() => {
      host.push(2);
    });
    await view.findByText("ticks 1,2");
  });
});
