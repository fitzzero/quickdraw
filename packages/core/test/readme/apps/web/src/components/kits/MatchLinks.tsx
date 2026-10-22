"use client";

import {
  createPeerLink,
  createQuickdrawClient,
  onPeerRequest,
  useJoin,
  useQuickdraw,
  type PeerLink,
} from "@fitzzero/quickdraw-core/client";
import { useEffect, useRef, useState } from "react";
import { match, moveSchema, type Move } from "../../../../../packages/shared/src/kits/peers";

const qd = createQuickdrawClient({ match });

type OnMove = (userId: string, move: Move) => void;

// #region hook
function track(links: Map<string, PeerLink>, link: PeerLink, onMove: { current: OnMove }): void {
  links.set(link.peer, link);
  link.on("message", (data) => {
    // a peer's message is its word, never checked by the server: parse it as any input
    const move = moveSchema.safeParse(data);
    // userId: the peer's user, as the server named it (known once the link is open)
    if (move.success && link.userId !== undefined) {
      onMove.current(link.userId, move.data);
    }
  });
  link.on("close", () => links.delete(link.peer));
}

// each player of a match linked to every other: send a move to all of them, hear theirs
export function useMatchLinks(matchId: string, onMove: OnMove): (move: Move) => void {
  const { connection } = useQuickdraw();
  const room = `match:${matchId}`;
  const [links] = useState(() => new Map<string, PeerLink>());
  const heard = useRef(onMove);
  useEffect(() => {
    heard.current = onMove;
  });
  // on every connection: a link lives as long as its socket, and a reconnect is a new socket
  useJoin(qd.match.enterMatch, { matchId });
  // a player who joins later: this side offers (when both offer, the link settles who answers)
  qd.match.playerJoined.useEvent((player) => {
    const self = connection.socket.id;
    if (player.matchId === matchId && player.socketId !== self && !links.has(player.socketId)) {
      track(links, createPeerLink(connection, { room, to: player.socketId, offerer: true }), heard);
    }
  });
  // the players here before: they offer, this side answers
  useEffect(
    () =>
      onPeerRequest(connection, (request) => {
        if (request.room === room) {
          track(links, request.accept(), heard);
        }
      }),
    [connection, room, links],
  );
  useEffect(
    () => () => {
      for (const link of links.values()) {
        link.close();
      }
    },
    [connection, room, links],
  );
  // direct when WebRTC connects, the server's relay when it cannot; fast: unordered, never resent
  return (move) => {
    for (const link of links.values()) {
      link.send("fast", move);
    }
  };
}
// #endregion
