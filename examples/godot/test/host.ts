// The world's host (host mode): a Node client of user "bo", on a socket of
// its own, that serves the host-served members of `game.ts` with
// `defineHost` and then calls `host`, which makes its socket the world's
// host. Its `world` seed is the current tick; each `steer` pushes the next
// tick, naming the user who steered. The wire test (`wire.test.ts`) links a
// raw socket to it with the GDScript client's frames, and the Godot check
// (`godot.ts`) links the client itself, both over the relay.

import { callData, createQuickdrawConnection, defineHost } from "@fitzzero/quickdraw-core/client";
import { game, WORLD, type GameServer } from "./game";

/** The world's host, serving. */
export interface WorldHost {
  /** Its socket's id, which `qd:host` names. */
  readonly socketId: string;
  /** The steers its handler served: each payload, with the user of the peer who sent it. */
  readonly steers: readonly (readonly [unknown, string])[];
  /** Stops serving: closes its links, and answers no more. Its socket stays the world's host. */
  stop(): void;
  /** Disconnects it: the world has no host then. */
  close(): void;
}

/** Connects the host, serves the world on its socket, and makes that socket the world's host. */
export async function hostWorld(server: GameServer): Promise<WorldHost> {
  const connection = createQuickdrawConnection({
    url: server.url,
    auth: "bo",
    transports: ["websocket"],
  });
  connection.open();
  await new Promise<void>((resolve) => {
    const off = connection.onHello(() => {
      off();
      resolve();
    });
  });
  const steers: [unknown, string][] = [];
  let tick = 0;
  const host = defineHost(game, {
    channels: {
      steer: (steer, { peer }) => {
        steers.push([steer, peer.userId]);
        tick += 1;
        host.stream("world").push(steer.worldId, { tick, by: peer.userId });
      },
    },
    streams: { world: { seed: () => [{ tick, by: "" }] } },
  }).serve(connection, { room: WORLD });
  const made = await callData(connection, {
    service: "gameService",
    method: "host",
    input: {},
    kind: "mutation",
  });
  if (made !== true) {
    connection.close();
    throw new Error("hostWorld: the server made no socket the world's host");
  }
  return {
    socketId: connection.socket.id ?? "",
    steers,
    stop: () => {
      host.close();
    },
    close: () => {
      host.close();
      connection.close();
    },
  };
}
