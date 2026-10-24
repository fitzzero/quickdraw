// Sending a stream's pushed items (`streams.ts`): kept in the feed's seed
// and sent to the feed's room as `qd:stream` frames. Behind a cluster
// adapter a stream that keeps a seed, or is volatile, is pushed to every
// node of the server's deployment instead (`quickdraw:stream-push`, tagged
// with it: `../cluster/deployment.ts`), and each node keeps the items in its
// own seed and sends them to its own sockets in the feed's room, in one
// step; a push of another deployment is never kept or sent.
//
// A volatile stream's frame skips a socket whose connection is backed up
// (`backlog.ts`), which only the node that holds the socket can tell: so
// each node sends to its own sockets, never through the adapter's room
// broadcast, which would reach the other nodes' sockets unchecked. Each
// frame is still one broadcast, encoded once, past the sockets it skips.

import { SERVER_EVENTS, streamRoom } from "../../contract/names";
import type { StreamFrame } from "../../protocol/envelope";
import { emitToNodes, onNodeEvent } from "../cluster/deployment";
import type { Hub } from "../emit/hub";
import type { AnyService } from "../service";
import type { QuickdrawIo } from "../transports/types";
import { backedUp, countSend } from "./backlog";
import { streamKey, type StreamSeeds } from "./seeds";
import type { ServiceStream } from "./types";

/** A stream the dispatcher serves, with its service. */
export interface Served {
  readonly service: AnyService;
  readonly stream: ServiceStream;
}

/** The server-to-server event a seeded or volatile stream's items are pushed to every node on, behind a cluster adapter. */
export const STREAM_PUSH_EVENT = "quickdraw:stream-push";

/** A push another node broadcast: `{ s, stream, scope?, items }`. */
interface PushedItems {
  readonly s: string;
  readonly stream: string;
  readonly scope?: string;
  readonly items: readonly unknown[];
}

/**
 * The sockets of `ids` (this node's) a message that may be dropped skips:
 * those whose connection is backed up. Every other one is counted for it.
 */
function backedUpOf(io: QuickdrawIo, ids: ReadonlySet<string>): string[] {
  const skipped: string[] = [];
  for (const id of ids) {
    const socket = io.sockets.sockets.get(id);
    if (socket === undefined) {
      continue;
    }
    if (backedUp(socket)) {
      skipped.push(id);
    } else {
      countSend(socket);
    }
  }
  return skipped;
}

/** Sends each of `frames` to this node's sockets in `room`, but those whose connection is backed up. */
function sendVolatile(io: QuickdrawIo, room: string, frames: readonly StreamFrame[]): void {
  const ids = io.sockets.adapter.rooms.get(room);
  if (ids === undefined) {
    return;
  }
  const target = io.local.to(room);
  for (const frame of frames) {
    const skipped = backedUpOf(io, ids);
    (skipped.length === 0 ? target : target.except(skipped)).emit(SERVER_EVENTS.stream, frame);
  }
}

/**
 * Keeps `items` (already checked) in the feed's seed and sends each as a
 * frame, in order: to every node's sockets in the feed's room, or with
 * `local` (a push another node broadcast) to this node's only.
 */
export function sendItems(
  hub: Hub,
  seeds: StreamSeeds,
  served: Served,
  feed: string | undefined,
  items: readonly unknown[],
  local = false,
): void {
  const { service, stream } = served;
  for (const item of items) {
    seeds.push(streamKey(service.name, stream.name), feed, item, stream.seed);
  }
  const { io } = hub;
  if (io === undefined) {
    return;
  }
  const replicated = local || ((stream.seed > 0 || stream.volatile) && !hub.probe.local());
  if (replicated && !local) {
    const pushed: PushedItems = { s: service.name, stream: stream.name, items };
    emitToNodes(io, STREAM_PUSH_EVENT, feed === undefined ? pushed : { ...pushed, scope: feed });
  }
  const room = streamRoom(service.name, stream.name, feed);
  const scope = feed ?? null;
  const frames = items.map((item): StreamFrame => [service.name, stream.name, scope, item]);
  if (stream.volatile) {
    sendVolatile(io, room, frames);
    return;
  }
  const target = (replicated ? io.local : io).to(room);
  for (const frame of frames) {
    target.emit(SERVER_EVENTS.stream, frame);
  }
}

/** A push another node broadcast, read; `undefined` for anything malformed or a stream not served here. */
function readPush(hub: Hub, value: unknown): { served: Served; pushed: PushedItems } | undefined {
  const { s, stream, scope, items } = (value ?? {}) as Readonly<Record<string, unknown>>;
  const service = typeof s === "string" ? hub.registry.services.get(s) : undefined;
  const found = typeof stream === "string" ? service?.streams.get(stream) : undefined;
  if (service === undefined || found === undefined || !Array.isArray(items)) {
    return undefined;
  }
  if (found.scoped ? typeof scope !== "string" : scope !== undefined) {
    return undefined;
  }
  const pushed: PushedItems = { s: service.name, stream: found.name, items: items as unknown[] };
  return {
    served: { service, stream: found },
    pushed: typeof scope === "string" ? { ...pushed, scope } : pushed,
  };
}

/** Keeps and sends the items other nodes of the server's deployment push to seeded streams. */
export function listenForPushes(hub: Hub, seeds: StreamSeeds): void {
  if (hub.io === undefined) {
    return;
  }
  onNodeEvent(hub.io, hub.logger, STREAM_PUSH_EVENT, (broadcast) => {
    const received = readPush(hub, broadcast);
    if (received !== undefined) {
      const { served, pushed } = received;
      sendItems(hub, seeds, served, pushed.scope, pushed.items, true);
    }
  });
}
