// `defineHost(contract, { channels, streams })` (host mode, RFC 0003 section
// 12.5): how a client serves a contract's host-served channels and streams
// as the host of an app room. `serve(connection, { room })` serves them for
// one room whose host a method made this connection's socket
// (`ctx.rooms.setHost(room)`): it answers the link requests of the room's
// peers (`onPeerRequest`: peers offer, the host answers), runs each
// channel's handler on messages checked as the server checks `qd:ch`
// (`runtime.ts`), answers a subscribe with the feed's seed, and sends what
// `host.stream(name).push(scope, item)` pushes to the feed's subscribers.
// This client's own channels and feeds of the room reach it in process
// (`links.ts`).
//
// The server never sees what a host and its peers send each other: a host
// trusts its peers' messages no more than the server would, and a service
// trusts no result a host reports without checking it.
//
// React-free.

import type { AnyContract } from "../../contract/defineContract";
import type {
  ChannelPayloadOf,
  HostChannelName,
  HostStreamName,
  StreamItemOf,
} from "../../contract/infer";
import { isHostServed } from "../../contract/realtime";
import { isRoomName } from "../../protocol/peer";
import { MAX_PEER_MESSAGE_BYTES } from "../../protocol/version";
import type { QuickdrawConnection } from "../connection";
import { controlOf } from "../peer/core";
import { onPeerRequest, type PeerRequest } from "../peer/link";
import { registerLocalHost } from "./links";
import {
  createHostRuntime,
  type AnyHostImplementation,
  type HostChannelContext,
  type HostPeer,
} from "./runtime";

export type { HostChannelContext, HostPeer } from "./runtime";

/** A host-served channel's handler: it runs once per message, with the payload its schema parsed. */
export type HostChannelHandler<Payload> = (payload: Payload, ctx: HostChannelContext) => void;

/** One host-served stream's options. */
export interface HostStreamOptions<Item> {
  /**
   * Computes a subscriber's seed when it subscribes, at once: the current
   * state, where the items that follow are deltas. Each item is checked
   * against the stream's schema. Without it the seed is the latest items
   * pushed to the scope, as many as the contract's `seed` (default none).
   */
  readonly seed?: (scope: string) => readonly Item[];
}

/**
 * `defineHost`'s second argument: one handler per host-served channel of
 * the contract, and options per host-served stream.
 */
export type HostImplementation<C extends AnyContract> = {
  readonly streams?: {
    readonly [K in HostStreamName<C>]?: HostStreamOptions<StreamItemOf<C, K>>;
  };
} & ([HostChannelName<C>] extends [never]
  ? { readonly channels?: Readonly<Record<string, never>> }
  : {
      readonly channels: {
        readonly [K in HostChannelName<C>]: HostChannelHandler<ChannelPayloadOf<C, K>>;
      };
    });

/** A host-served stream, as its host pushes to it. */
export interface HostStream<Item> {
  /**
   * Sends `item` to the subscribers of the feed of `scope`, after checking
   * it against the stream's schema (a `TypeError` when it fails), and keeps
   * it for the seed. A `RangeError` for an item over the message limit
   * (`limits.peers.maxMessageBytes` with its message).
   */
  push(scope: string, item: Item): void;
}

/** A room served by its host's client. */
export interface Host<C extends AnyContract> {
  readonly room: string;
  /** The peers linked to the host now (this client too, while its own channels or feeds use the room). */
  readonly peers: readonly HostPeer[];
  /** A host-served stream of the contract. */
  stream<K extends HostStreamName<C>>(name: K): HostStream<StreamItemOf<C, K>>;
  /** Stops serving the room: closes every peer's link, and answers no request of it. */
  close(): void;
}

/** What `defineHost` returns: the contract, and how to serve one of its rooms. */
export interface HostDefinition<C extends AnyContract> {
  readonly contract: C;
  /**
   * Serves app room `room` on `connection`, whose socket a method made the
   * room's host (`ctx.rooms.setHost`). Call it once per room, and `close()`
   * when the socket is no longer the host (`onHostChange`, a reconnect).
   */
  serve(connection: QuickdrawConnection, options: { readonly room: string }): Host<C>;
}

function checkImplementation(contract: AnyContract, implementation: AnyHostImplementation): void {
  const owner = `defineHost(${contract.name})`;
  const channels = implementation.channels ?? {};
  for (const [name, def] of Object.entries(contract.channels)) {
    const handler = Object.hasOwn(channels, name) ? channels[name] : undefined;
    if (isHostServed(def) && typeof handler !== "function") {
      throw new TypeError(
        `${owner}: channels.${name} must be a handler: the room's host serves it`,
      );
    }
  }
  for (const name of Object.keys(channels)) {
    const def = Object.hasOwn(contract.channels, name) ? contract.channels[name] : undefined;
    if (def === undefined || !isHostServed(def)) {
      throw new TypeError(`${owner}: "${name}" is not a channel the room's host serves`);
    }
  }
  for (const [name, options] of Object.entries(implementation.streams ?? {})) {
    const def = Object.hasOwn(contract.streams, name) ? contract.streams[name] : undefined;
    if (def === undefined || !isHostServed(def)) {
      throw new TypeError(`${owner}: "${name}" is not a stream the room's host serves`);
    }
    if (options?.seed !== undefined && typeof options.seed !== "function") {
      throw new TypeError(`${owner}: streams.${name}.seed must be a function of the scope`);
    }
  }
}

function serve<C extends AnyContract>(
  contract: C,
  implementation: AnyHostImplementation,
  connection: QuickdrawConnection,
  room: string,
): Host<C> {
  if (!isRoomName(room)) {
    throw new TypeError("serve: room must name an app room, of 1 to 256 characters");
  }
  const runtime = createHostRuntime(
    contract,
    implementation,
    room,
    () => connection.getState().hello?.limits.peers?.maxMessageBytes ?? MAX_PEER_MESSAGE_BYTES,
  );
  const links = new Set<ReturnType<PeerRequest["accept"]>>();
  let closed = false;
  const attach = (request: PeerRequest): void => {
    let link;
    try {
      link = request.accept();
    } catch {
      // A link the app opened itself to that peer, in this room.
      return;
    }
    const control = controlOf(link);
    if (control === undefined) {
      return;
    }
    links.add(link);
    const peer: HostPeer = { socketId: request.from, userId: request.userId };
    const attached = runtime.attach(peer, control.send, () => {
      link.close();
    });
    const off = control.on((message) => {
      attached.receive(message);
    });
    link.on("close", () => {
      off();
      attached.detach();
      links.delete(link);
    });
  };
  const stopRequests = onPeerRequest(connection, (request) => {
    if (!closed && request.room === room) {
      attach(request);
    }
  });
  const unregister = registerLocalHost(connection, room, (peer, send) =>
    runtime.attach(peer, send, () => undefined),
  );
  return Object.freeze({
    room,
    get peers(): readonly HostPeer[] {
      return runtime.peers;
    },
    stream: (name: string) =>
      Object.freeze({
        push: (scope: string, item: unknown) => {
          runtime.push(name, scope, item);
        },
      }),
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      stopRequests();
      unregister();
      for (const link of [...links]) {
        link.close();
      }
      runtime.close();
    },
  }) as Host<C>;
}

/**
 * Declares how a client serves a contract's host-served channels and
 * streams (`serve: "host"`) as the host of an app room: one handler per
 * channel, and options per stream. Throws a `TypeError` for a handler a
 * host-served channel lacks, or for a member the room's host does not
 * serve.
 *
 * @example
 * const worldHost = defineHost(game, {
 *   channels: { move: (move, { peer }) => world.input(peer.userId, move) },
 *   streams: { world: { seed: () => [world.snapshot()] } },
 * });
 * const host = worldHost.serve(connection, { room: `world:${worldId}` });
 * host.stream("world").push(worldId, world.snapshot());
 */
export function defineHost<const C extends AnyContract>(
  contract: C,
  implementation: HostImplementation<C>,
): HostDefinition<C> {
  const any = implementation as AnyHostImplementation;
  checkImplementation(contract, any);
  return Object.freeze({
    contract,
    serve: (connection: QuickdrawConnection, options: { readonly room: string }) =>
      serve(contract, any, connection, options.room),
  });
}
