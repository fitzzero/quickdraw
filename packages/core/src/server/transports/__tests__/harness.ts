// Real servers on port 0 and real Socket.IO clients for the transport tests,
// closed after each test.

import type { AddressInfo } from "node:net";
import { Server, type Namespace, type ServerOptions as IoServerOptions } from "socket.io";
import { io, type ManagerOptions, type Socket, type SocketOptions } from "socket.io-client";
import { afterEach } from "vitest";
import { PROTOCOL_VERSION, type HelloFrame } from "../../../index";
import {
  createServer,
  type AnyService,
  type QuickdrawIo,
  type QuickdrawServer,
  type ServerAuth,
  type ServerOptions,
} from "../../index";
import { alice, type AppPrincipal } from "../../__tests__/fixtures";

export type ClientSocket = Socket;

/** The `auth` a v5 test client connects with; `principal` is trusted by {@link trustingAuth}. */
export function v5Auth(principal: AppPrincipal | null = alice): Record<string, unknown> {
  const qd = { protocol: PROTOCOL_VERSION, client: "test" };
  return principal === null ? { qd } : { principal, qd };
}

/** An `authenticate` that trusts the `principal` in the handshake's `auth`. */
export const trustingAuth: ServerAuth<AppPrincipal> = {
  authenticate: ({ auth }) => (auth.principal as AppPrincipal | undefined) ?? null,
};

/** A client socket with its handshake outcome. */
export interface Opened {
  readonly socket: ClientSocket;
  /** Resolves on `connect`, rejects with the `connect_error`. */
  readonly connected: Promise<void>;
  /** Resolves with the server's `qd:hello`. */
  readonly hello: Promise<HelloFrame>;
}

export interface Harness {
  /** Creates a server and listens on a free port. */
  start<const S extends readonly AnyService[]>(
    options: ServerOptions<S>,
  ): Promise<{ readonly server: QuickdrawServer<S>; readonly url: string }>;
  /** Opens a client socket that never reconnects. */
  open(
    url: string,
    auth: Record<string, unknown> | undefined,
    options?: Partial<ManagerOptions & SocketOptions>,
  ): Opened;
}

/** Registers the cleanup and returns the helpers. Call it once per test file. */
export function transportHarness(): Harness {
  const servers: QuickdrawServer[] = [];
  const clients: ClientSocket[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.disconnect();
    }
    await Promise.all(servers.splice(0).map(async (server) => await server.close()));
  });

  return {
    async start(options) {
      const server = createServer(options);
      servers.push(server as unknown as QuickdrawServer);
      await new Promise<void>((resolve) => {
        server.httpServer.listen(0, "127.0.0.1", resolve);
      });
      const { port } = server.httpServer.address() as AddressInfo;
      return { server, url: `http://127.0.0.1:${port}` };
    },
    open(url, auth, options = {}) {
      const socket = io(url, {
        forceNew: true,
        reconnection: false,
        autoConnect: false,
        transports: ["websocket"],
        ...(auth === undefined ? {} : { auth }),
        ...options,
      });
      clients.push(socket);
      const hello = new Promise<HelloFrame>((resolve) => {
        socket.once("qd:hello", resolve);
      });
      const connected = new Promise<void>((resolve, reject) => {
        socket.once("connect", () => {
          resolve();
        });
        socket.once("connect_error", reject);
      });
      socket.connect();
      return { socket, connected, hello };
    },
  };
}

/** Sends `qd:call` and resolves with the acknowledgement. */
export function call(socket: ClientSocket, envelope: unknown, timeoutMs = 2000): Promise<unknown> {
  return socket.timeout(timeoutMs).emitWithAck("qd:call", envelope);
}

/** Resolves on the next `event` the socket receives. */
export function next<T = unknown>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve) => {
    socket.once(event, resolve);
  });
}

/**
 * A Socket.IO adapter that hands `serverSideEmit` to the other servers it was
 * made for: a cluster in one process. A broadcast that asks for answers
 * (`serverSideEmitWithAck`) gets one from each peer, as the Redis adapter's
 * does.
 */
export function peeredCluster(): {
  readonly adapter: NonNullable<Partial<IoServerOptions>["adapter"]>;
  readonly servers: QuickdrawIo[];
} {
  const servers: QuickdrawIo[] = [];
  // A server attached to nothing holds no resources; it only shows the default adapter class.
  const Base = new Server().of("/").adapter.constructor as new (
    nsp: Namespace,
  ) => Namespace["adapter"];
  type Peer = { _onServerSideEmit(args: unknown[]): void };
  class PeeredAdapter extends Base {
    override serverSideEmit(packet: unknown[]): void {
      const peers = servers.filter((peer) => peer.sockets !== this.nsp);
      const last = packet.at(-1);
      if (typeof last !== "function") {
        for (const peer of peers) {
          (peer.sockets as unknown as Peer)._onServerSideEmit(packet);
        }
        return;
      }
      const ack = last as (error: Error | null, responses: unknown[]) => void;
      const responses: unknown[] = [];
      if (peers.length === 0) {
        ack(null, responses);
      }
      for (const peer of peers) {
        const answer = (response: unknown): void => {
          responses.push(response);
          if (responses.length === peers.length) {
            ack(null, responses);
          }
        };
        (peer.sockets as unknown as Peer)._onServerSideEmit([...packet.slice(0, -1), answer]);
      }
    }
  }
  return {
    adapter: PeeredAdapter as unknown as NonNullable<Partial<IoServerOptions>["adapter"]>,
    servers,
  };
}
