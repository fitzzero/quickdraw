// Pushing to streams (RFC 0003 section 12.5): `qd.stream(contract,
// name).push(scope, item)` (`push(item)` for a global stream). The item is
// checked against the stream's item schema (a mismatch throws `INTERNAL`,
// nothing is kept or sent); the validated item (a Zod object strips keys its
// schema does not name) is kept in the scope's seed when the stream declares
// one (`seeds.ts`), and sent to the feed's room as `qd:stream { s, stream,
// scope?, item }`, volatile when the stream says so. A push is synchronous
// and logs nothing: it may run at a game loop's tick rate.
//
// `pushMany(scope, items)` (`pushMany(items)`) is the batch form: every item
// is checked before any is kept or sent, then each goes out as its own frame
// through one room operator, in order, so the client applies them exactly as
// it applies single pushes.

import type { AnyContract } from "../../contract/defineContract";
import { SERVER_EVENTS, streamRoom } from "../../contract/names";
import type { StreamFrame } from "../../protocol/envelope";
import type { Hub } from "../emit/hub";
import type { AnyService } from "../service";
import { StreamSeeds, streamKey } from "./seeds";
import { createStreamFeeds, type StreamFeeds } from "./streamFeeds";
import { scopeProblem } from "./streamTargets";
import type { ServiceStream, StreamHandle } from "./types";
import { checkOutgoing } from "./validate";

interface Served {
  readonly service: AnyService;
  readonly stream: ServiceStream;
}

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

/** Keeps `items` (already checked) in the feed's seed and sends each as a frame, in order. */
function send(
  hub: Hub,
  seeds: StreamSeeds,
  served: Served,
  feed: string | undefined,
  items: readonly unknown[],
): void {
  const { service, stream } = served;
  for (const item of items) {
    seeds.push(streamKey(service.name, stream.name), feed, item, stream.seed);
  }
  const { io } = hub;
  if (io === undefined) {
    return;
  }
  const room = io.to(streamRoom(service.name, stream.name, feed));
  const target = stream.volatile ? room.volatile : room;
  for (const item of items) {
    const frame: StreamFrame =
      feed === undefined
        ? { s: service.name, stream: stream.name, item }
        : { s: service.name, stream: stream.name, scope: feed, item };
    target.emit(SERVER_EVENTS.stream, frame);
  }
}

function push(hub: Hub, seeds: StreamSeeds, served: Served, args: readonly unknown[]): void {
  const { feed, value } = feedOf(served, "push", "item", args);
  const label = `${served.service.name}.${served.stream.name}`;
  // What is kept and sent is the validated item: streams have no projections.
  const checked = checkOutgoing(served.stream.item, value, `An item pushed to ${label}`);
  send(hub, seeds, served, feed, [checked]);
}

function pushMany(hub: Hub, seeds: StreamSeeds, served: Served, args: readonly unknown[]): void {
  const { feed, value } = feedOf(served, "pushMany", "items", args);
  const label = `${served.service.name}.${served.stream.name}`;
  if (!Array.isArray(value)) {
    throw new TypeError(`${label}.pushMany: pass the items as an array`);
  }
  // Every item is checked before any is kept or sent.
  const checked = value.map((item: unknown, index) =>
    checkOutgoing(served.stream.item, item, `Item ${String(index)} pushed to ${label}`),
  );
  send(hub, seeds, served, feed, checked);
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
  });
}
