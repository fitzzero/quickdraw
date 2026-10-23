// A stand-in server for the peer link unit tests, which run on fake timers:
// connections whose sockets talk to a router here that forwards `qd:peer`
// and `qd:relay` as the server does (naming the sender's socket and user) a
// task later, and acknowledges each signal with `answer(frame)` (`Ok` by
// default). It models no rooms and no limits: `server/realtime/peers.test.ts`
// covers those, and `../peer.test.ts` runs links against a real server.

import { DEFAULT_PEER_LIMITS } from "../hub";
import type { Failure, Ok, PeerSignalFrame } from "../../../protocol/envelope";
import type { HelloFrame, HelloPeerLimits } from "../../../protocol/version";
import type { ConnectionState, QuickdrawConnection } from "../../connection";
import { FakeSocket } from "./fakeSocket";

export { FakeSocket, type Sent } from "./fakeSocket";

/** A fake connection: its socket, and a state with a hello. */
export interface FakeConnection {
  readonly connection: QuickdrawConnection;
  readonly socket: FakeSocket;
  /** Replaces the state, telling the connection's subscribers. */
  setState(state: Partial<ConnectionState>): void;
  /** The socket disconnects: the connection reconnects, without a hello. */
  drop(): void;
}

/** A hello naming `userId`, with `features` and, when given, peer limits. */
export function helloOf(
  userId: string,
  features: readonly string[] = ["peer"],
  peers: HelloPeerLimits | undefined = DEFAULT_PEER_LIMITS,
): HelloFrame {
  return {
    protocol: 5,
    server: "test",
    serverId: "server",
    limits: {
      maxInFlightQueries: 16,
      maxQueuedQueries: 64,
      maxSubscribeIds: 500,
      callTimeoutMs: 30_000,
      subscriptions: { maxInFlight: 8, maxQueued: 64 },
      ...(peers === undefined ? {} : { peers }),
    },
    features,
    userId,
    serviceAccess: {},
  };
}

/** Options of {@link Wire.connect}. */
export interface ConnectOptions {
  /** The hello's features. Default `["peer"]`. */
  readonly features?: readonly string[];
  /** The hello's peer limits. Default this version's. */
  readonly peers?: HelloPeerLimits;
  /** Connected with a hello at once. Default true. */
  readonly ready?: boolean;
}

export class Wire {
  readonly sockets = new Map<string, FakeSocket>();
  /** The acknowledgement each signal gets. */
  answer: (from: FakeSocket, frame: PeerSignalFrame) => Ok | Failure = () => ({ ok: true });
  /** Sockets whose incoming relay messages and signals are lost. */
  readonly deaf = new Set<string>();

  connect(userId: string, options: ConnectOptions = {}): FakeConnection {
    const socket = new FakeSocket(this, `socket-of-${userId}`, userId);
    this.sockets.set(socket.id, socket);
    const hello = helloOf(
      userId,
      options.features ?? ["peer"],
      options.peers ?? DEFAULT_PEER_LIMITS,
    );
    const subscribers = new Set<() => void>();
    let state = {
      status: options.ready === false ? "connecting" : "connected",
      reconnecting: false,
      hello: options.ready === false ? null : hello,
      serviceAccess: null,
      refusal: null,
      backoff: {},
    } as ConnectionState;
    const setState = (next: Partial<ConnectionState>): void => {
      state = { ...state, ...next };
      for (const subscriber of [...subscribers]) {
        subscriber();
      }
    };
    const connection = {
      url: "fake",
      timeoutMs: 10_000,
      socket,
      getState: () => state,
      subscribe: (listener: () => void) => {
        subscribers.add(listener);
        return () => {
          subscribers.delete(listener);
        };
      },
    } as unknown as QuickdrawConnection;
    return {
      connection,
      socket,
      setState,
      drop: () => {
        socket.connected = false;
        socket.receive("disconnect", "transport close");
        setState({ status: "connecting", reconnecting: true, hello: null });
      },
    };
  }

  /** A frame a socket sent: a signal is forwarded and acknowledged, a relay message forwarded. */
  route(from: FakeSocket, event: string, frame: unknown): unknown {
    if (event === "qd:peer") {
      const signal = frame as PeerSignalFrame;
      const answer = this.answer(from, signal);
      const target = this.sockets.get(signal.to);
      if (answer.ok && target !== undefined && !this.deaf.has(target.id)) {
        const forward = { room: signal.room, from: from.id, userId: from.userId, sig: signal.sig };
        setTimeout(() => {
          target.receive("qd:peer", forward);
        }, 0);
      }
      return answer;
    }
    if (event === "qd:relay") {
      const [room, to, label, text] = frame as readonly [string, string, string, string];
      const target = this.sockets.get(to);
      if (target !== undefined && !this.deaf.has(to)) {
        setTimeout(() => {
          target.receive("qd:relay", [room, from.id, label, text]);
        }, 0);
      }
    }
    return undefined;
  }
}
