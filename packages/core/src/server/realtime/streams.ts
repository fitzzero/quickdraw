// Pushing to streams (RFC 0003 section 12.5): `qd.stream(contract,
// name).push(scope, item)` (`push(item)` for a global stream). The item is
// checked against the stream's item schema (a mismatch throws `INTERNAL`,
// nothing is kept or sent); the validated item (a Zod object strips keys its
// schema does not name) is kept in the scope's seed when the stream declares
// one (`seeds.ts`), and sent to the feed's room as `qd:stream [service,
// stream, scope, item]` (`scope` null for a global stream: positional, so a
// frame at a game's tick rate carries no key names), volatile when the stream
// says so. A push is synchronous and logs nothing: it may run at a game
// loop's tick rate.
//
// `pushMany(scope, items)` (`pushMany(items)`) is the batch form: every item
// is checked before any is kept or sent, then each goes out as its own frame
// through one room operator, in order, so the client applies them exactly as
// it applies single pushes.
//
// Behind a cluster adapter a stream that keeps a seed is pushed to every
// node of its deployment instead (`serverSideEmit`, the same one publish a room broadcast
// costs), and each node keeps the items in its own seed and sends them to its
// own sockets in the feed's room, in one step: a subscriber on any node gets
// the latest items as its seed, and an item is either in the seed a
// subscriber gets or sent to it after, never both and never neither. A stream
// without a seed goes out through the adapter's room broadcast as before.

import type { AnyContract } from "../../contract/defineContract";
import type { Hub } from "../emit/hub";
import { StreamSeeds } from "./seeds";
import { createStreamFeeds, type StreamFeeds } from "./streamFeeds";
import { listenForPushes, sendItems, type Served } from "./streamPushes";
import { scopeProblem } from "./streamTargets";
import type { StreamHandle } from "./types";
import { checkOutgoing, checksItems } from "./validate";

/** The stream `name` of the service the dispatcher serves for `contract`, or a `TypeError`. */
function servedStream(hub: Hub, contract: AnyContract, name: string): Served {
  const serviceName: unknown =
    typeof contract === "object" && contract !== null ? contract.name : undefined;
  const service =
    typeof serviceName === "string" ? hub.registry.services.get(serviceName) : undefined;
  if (service === undefined) {
    throw new TypeError(
      `stream: the dispatcher serves no service named ${String(serviceName)}; pass a contract of one of its services`,
    );
  }
  const stream = typeof name === "string" ? service.streams.get(name) : undefined;
  if (stream === undefined) {
    throw new TypeError(`stream: ${service.name} has no stream "${String(name)}"`);
  }
  if (stream.host) {
    throw new TypeError(
      `stream: ${service.name}.${stream.name} is served by the room's host (serve: "host"): its host's client pushes it, with defineHost; the server cannot`,
    );
  }
  return { service, stream };
}

/**
 * The feed and the value `push(scope, value)` or `push(value)` names, or a
 * `TypeError`; `what` names the value in the message (`item`, `items`).
 */
function feedOf(
  served: Served,
  method: string,
  what: string,
  args: readonly unknown[],
): { readonly feed: string | undefined; readonly value: unknown } {
  const { service, stream } = served;
  const scope = stream.scoped ? args[0] : undefined;
  const problem = scopeProblem(stream, scope);
  if (problem !== undefined || args.length !== (stream.scoped ? 2 : 1)) {
    const usage = stream.scoped ? `pass (scope, ${what})` : `pass (${what})`;
    throw new TypeError(`${service.name}.${stream.name}.${method}: ${problem ?? usage}`);
  }
  return { feed: scope as string | undefined, value: stream.scoped ? args[1] : args[0] };
}

function push(hub: Hub, seeds: StreamSeeds, served: Served, args: readonly unknown[]): void {
  const { feed, value } = feedOf(served, "push", "item", args);
  const label = `${served.service.name}.${served.stream.name}`;
  // What is kept and sent is the validated item: streams have no projections.
  const checked = checksItems(served.stream, hub.outputValidation)
    ? checkOutgoing(served.stream.item, value, `An item pushed to ${label}`)
    : value;
  sendItems(hub, seeds, served, feed, [checked]);
}

function pushMany(hub: Hub, seeds: StreamSeeds, served: Served, args: readonly unknown[]): void {
  const { feed, value } = feedOf(served, "pushMany", "items", args);
  const label = `${served.service.name}.${served.stream.name}`;
  if (!Array.isArray(value)) {
    throw new TypeError(`${label}.pushMany: pass the items as an array`);
  }
  if (!checksItems(served.stream, hub.outputValidation)) {
    sendItems(hub, seeds, served, feed, value);
    return;
  }
  // Every item is checked before any is kept or sent.
  const checked = value.map((item: unknown, index) =>
    checkOutgoing(served.stream.item, item, `Item ${String(index)} pushed to ${label}`),
  );
  sendItems(hub, seeds, served, feed, checked);
}

/** One dispatcher's streams: their seeds, the handles that push to them, and their socket listeners. */
export interface Streams {
  /**
   * The handle of stream `name` of `contract`'s service on this dispatcher.
   * Throws a `TypeError` when the dispatcher does not serve that stream.
   */
  handle(contract: AnyContract, name: string): StreamHandle<AnyContract, string>;
  /** Serves `qd:stream:sub` and `qd:stream:unsub` on a v5 socket. */
  readonly extension: Feeds["extension"];
  /** Authorizes the feeds an access change or a changed grant concerns again (`streamRevocation.ts`). */
  readonly revocation: Feeds["revocation"];
  /** Keeps and sends the items other nodes push to seeded streams, on the server the hub was given. */
  listen(): void;
  /** The socket left an app room: revokes its feeds open to a room it is no longer in. */
  readonly leftRooms: Feeds["leftRooms"];
}

type Feeds = StreamFeeds;

/** Creates the streams of the dispatcher whose hub this is. */
export function createStreams(hub: Hub): Streams {
  const seeds = new StreamSeeds();
  const feeds = createStreamFeeds(hub, seeds);
  return Object.freeze({
    handle(contract: AnyContract, name: string): StreamHandle<AnyContract, string> {
      const served = servedStream(hub, contract, name);
      return Object.freeze({
        push: (...args: unknown[]) => {
          push(hub, seeds, served, args);
        },
        pushMany: (...args: unknown[]) => {
          pushMany(hub, seeds, served, args);
        },
      }) as StreamHandle<AnyContract, string>;
    },
    extension: feeds.extension,
    revocation: feeds.revocation,
    leftRooms: feeds.leftRooms,
    listen: () => {
      listenForPushes(hub, seeds);
    },
  });
}
