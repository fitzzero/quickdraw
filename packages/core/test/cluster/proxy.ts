// A TCP proxy in front of the cluster projects' Valkey that a test can cut
// and restore: Valkey "stops" for the nodes behind it, and for no other test
// running on the same Valkey at the same time.

import net from "node:net";
import { VALKEY_URL } from "./valkey";

/** A cuttable connection to Valkey. */
export interface ValkeyProxy {
  /** The URL the nodes connect to. */
  readonly url: string;
  /** Drops every connection and refuses new ones until `restore`. */
  cut(): Promise<void>;
  /** Accepts connections again, on the same port. */
  restore(): Promise<void>;
  close(): Promise<void>;
}

function listen(server: net.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

/** Starts a proxy to the cluster projects' Valkey on a free port. */
export async function startValkeyProxy(): Promise<ValkeyProxy> {
  const target = new URL(VALKEY_URL);
  const sockets = new Set<net.Socket>();
  const pipe = (client: net.Socket): void => {
    const upstream = net.connect(Number(target.port || 6379), target.hostname);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => {
        sockets.delete(socket);
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream).pipe(client);
  };
  let server = net.createServer(pipe);
  const port = await listen(server, 0);
  const drop = (): Promise<void> =>
    new Promise((resolve) => {
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      server.close(() => {
        resolve();
      });
    });
  return {
    url: `redis://127.0.0.1:${port}`,
    cut: drop,
    async restore() {
      server = net.createServer(pipe);
      await listen(server, port);
    },
    close: drop,
  };
}
