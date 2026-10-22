// The peer link tests' service and helpers (`../peers.test.ts` and the
// cluster's `test/cluster/peers.test.ts`): a lobby without a model whose
// methods put the calling socket in an app room, take it out, or take a
// user out, and a peer socket that records the `qd:peer` and `qd:relay`
// frames it receives.

import { z } from "zod";
import { settleCluster } from "../../../../test/cluster/mode";
import { defineContract, mutation } from "../../../index";
import type {
  Failure,
  Ok,
  PeerForwardFrame,
  PeerLabel,
  PeerSignal,
  RelayForwardFrame,
} from "../../../protocol/envelope";
import { emitWithAck, type TestConnection } from "../../../testing/index";
import type { AppPrincipal } from "../../__tests__/fixtures";
import { initQuickdraw } from "../../index";

/** The app room the tests' peers link in. */
export const GAME = "game:1";

/** A third player, for links among three. */
export const carol: AppPrincipal = { userId: "carol", kind: "user" };

const roomInput = z.object({ room: z.string() });

export const lobbyContract = defineContract("lobbyService", {
  methods: {
    enter: mutation({ input: roomInput, output: z.boolean() }),
    /** Joins with public access, so an anonymous socket can be in a room. */
    enterAnyone: mutation({ input: roomInput, output: z.boolean() }),
    exit: mutation({ input: roomInput, output: z.boolean() }),
    /** Takes every socket of a user out of a room: `ctx.rooms.leave(room, { userId })`. */
    kick: mutation({
      input: z.object({ room: z.string(), userId: z.string() }),
      output: z.null(),
    }),
  },
});

const qd = initQuickdraw<{ principal: AppPrincipal }>();

export function defineLobbyService() {
  return qd.defineService(lobbyContract, {
    methods: {
      enter: { access: "authenticated", handler: ({ input, ctx }) => ctx.rooms.join(input.room) },
      enterAnyone: { access: "public", handler: ({ input, ctx }) => ctx.rooms.join(input.room) },
      exit: { access: "authenticated", handler: ({ input, ctx }) => ctx.rooms.leave(input.room) },
      kick: {
        access: "authenticated",
        handler: async ({ input, ctx }) => {
          await ctx.rooms.leave(input.room, { userId: input.userId });
          return null;
        },
      },
    },
  });
}

type Connected = Pick<TestConnection, "socket">;

/** A socket of a test app, with the peer frames it received, in order. */
export interface Peer<C extends Connected = Connected> {
  readonly connection: C;
  /** The socket's id, which its peers address it by. */
  readonly id: string;
  readonly signals: PeerForwardFrame[];
  readonly relayed: RelayForwardFrame[];
  /** Sends `qd:peer` and resolves with the acknowledgement. */
  signal(
    room: string,
    to: string,
    sig: PeerSignal | Record<string, unknown>,
  ): Promise<Ok | Failure>;
  /** Sends `qd:relay`, plainly: the client sends `fast` volatile, which Socket.IO may drop on the client. */
  relay(room: string, to: string, label: PeerLabel, text: string): void;
}

/** Records the peer frames `connection` receives. */
export function peerOf<C extends Connected>(connection: C): Peer<C> {
  const signals: PeerForwardFrame[] = [];
  const relayed: RelayForwardFrame[] = [];
  connection.socket.on("qd:peer", (frame: PeerForwardFrame) => signals.push(frame));
  connection.socket.on("qd:relay", (frame: RelayForwardFrame) => relayed.push(frame));
  const id = connection.socket.id;
  if (id === undefined) {
    throw new Error("peerOf: the socket is not connected");
  }
  return {
    connection,
    id,
    signals,
    relayed,
    signal: (room, to, sig) => emitWithAck(connection.socket, "qd:peer", { room, to, sig }),
    relay: (room, to, label, text) => {
      connection.socket.emit("qd:relay", [room, to, label, text]);
    },
  };
}

/**
 * Waits until the server has handled every event the socket sent before now
 * (an acknowledged event sent after them comes back once they ran), and
 * everything another node published before now has reached this one.
 */
export async function settle(...peers: readonly Peer[]): Promise<void> {
  await settleCluster();
  for (const peer of peers) {
    await emitWithAck(peer.connection.socket, "qd:unsub", { s: "noService", ids: [] });
  }
}

/** An offer, as a browser writes one. */
export const OFFER: PeerSignal = {
  sdp: { type: "offer", sdp: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n" },
};

/** A link message carrying `data`, as `createPeerLink` writes it. */
export function message(data: unknown): string {
  return JSON.stringify([0, data]);
}
