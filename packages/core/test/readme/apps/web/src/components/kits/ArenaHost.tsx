"use client";

import {
  createQuickdrawClient,
  defineHost,
  hostOf,
  onHostChange,
  useJoin,
  useQuickdraw,
  type Host,
} from "@fitzzero/quickdraw-core/client";
import { useEffect } from "react";
import { arena, arenaRoom } from "../../../../../packages/shared/src/kits/host";

const qd = createQuickdrawClient({ arena });

// #region player
// a player reads the world and sends input as with any stream and channel: both reach the host
export function useArena(arenaId: string) {
  useJoin(qd.arena.enterArena, { arenaId });
  const { items } = qd.arena.world.useStream(arenaId);
  const { send } = qd.arena.steer.useChannel();
  return {
    world: items.at(-1),
    // on the link's fast: never resent, so send input every frame, not once
    steer: (dx: number, dy: number) => send({ arenaId, dx, dy }),
  };
}
// #endregion

// #region host
// the arenas this client simulates as their host: each player's position, by user
const arenas = new Map<string, { tick: number; players: Map<string, { x: number; y: number }> }>();

// a peer's input arrives checked against the contract (schema, room, rate), but it is still
// that player's word: the simulation applies it as it would any input
const arenaHost = defineHost(arena, {
  channels: {
    steer: (steer, { peer }) => {
      const players = arenas.get(steer.arenaId)?.players;
      const at = players?.get(peer.userId) ?? { x: 0, y: 0 };
      players?.set(peer.userId, { x: at.x + steer.dx, y: at.y + steer.dy });
    },
  },
});

// serves the arena while the server names this socket its host (qd:host), and stops when not
export function useArenaHost(arenaId: string): void {
  const { connection } = useQuickdraw();
  useEffect(() => {
    const room = arenaRoom(arenaId);
    let host: Host<typeof arena> | undefined;
    const settle = (): void => {
      const hosting = hostOf(connection, room) === connection.socket.id;
      if (hosting && host === undefined) {
        arenas.set(arenaId, { tick: 0, players: new Map() });
        host = arenaHost.serve(connection, { room });
      } else if (!hosting && host !== undefined) {
        host.close();
        host = undefined;
      }
    };
    const stop = onHostChange(connection, (changed) => {
      if (changed === room) {
        settle();
      }
    });
    settle();
    // the host's loop: twenty snapshots a second to every player of the arena
    const loop = setInterval(() => {
      const state = arenas.get(arenaId);
      if (host !== undefined && state !== undefined) {
        state.tick += 1;
        host.stream("world").push(arenaId, {
          tick: state.tick,
          players: Object.fromEntries(state.players),
        });
      }
    }, 50);
    return () => {
      stop();
      clearInterval(loop);
      host?.close();
    };
  }, [connection, arenaId]);
}
// #endregion

// #region fair
// the host's own play goes through an in-process link, one of host.peers: lag it to the median
// player's one-way delay, at most 100 ms, so the host plays over a link as laggy as its players'
export function matchPlayersLag(host: Host<typeof arena>, self: string | undefined): void {
  const oneWay = host.peers
    .filter((peer) => peer.socketId !== self)
    .map((peer) => peer.link.clock.rtt / 2)
    .sort((a, b) => a - b);
  const median = oneWay[Math.floor(oneWay.length / 2)] ?? 0;
  // call it now and then, as the players' round trips change: what is held keeps its time
  host.peers.find((peer) => peer.socketId === self)?.link.setLag({ ms: Math.min(100, median) });
}
// #endregion
