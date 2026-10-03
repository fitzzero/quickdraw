// Pushing to streams (RFC 0003 section 12.5): `qd.stream(contract,
// name).push(scope, item)` (`push(item)` for a global stream). The item is
// checked against the stream's item schema (a mismatch throws `INTERNAL`,
// nothing is kept or sent), kept in the scope's seed when the stream declares
// one (`seeds.ts`), and sent to the feed's room as `qd:stream { s, stream,
// scope?, item }`, volatile when the stream says so. A push is synchronous
// and logs nothing: it may run at a game loop's tick rate.

import type { AnyContract } from "../../contract/defineContract";
import { SERVER_EVENTS, streamRoom } from "../../contract/names";
import type { StreamFrame } from "../../protocol/envelope";
import type { Hub } from "../emit/hub";
import type { AnyService } from "../service";
import { StreamSeeds, streamKey } from "./seeds";
import { streamSubscriptions } from "./streamSubscriptions";
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

function push(hub: Hub, seeds: StreamSeeds, served: Served, args: readonly unknown[]): void {
  const { service, stream } = served;
  const label = `${service.name}.${stream.name}`;
  const scope = stream.scoped ? args[0] : undefined;
  const item = stream.scoped ? args[1] : args[0];
  const problem = scopeProblem(stream, scope);
  if (problem !== undefined || args.length !== (stream.scoped ? 2 : 1)) {
    throw new TypeError(
      `${label}.push: ${problem ?? (stream.scoped ? "pass (scope, item)" : "pass (item)")}`,
    );
  }
  checkOutgoing(stream.item, item, `An item pushed to ${label}`);
  const feed = scope as string | undefined;
  seeds.push(streamKey(service.name, stream.name), feed, item, stream.seed);
  const { io } = hub;
  if (io === undefined) {
    return;
  }
  const frame: StreamFrame =
    feed === undefined
      ? { s: service.name, stream: stream.name, item }
      : { s: service.name, stream: stream.name, scope: feed, item };
  const room = io.to(streamRoom(service.name, stream.name, feed));
  (stream.volatile ? room.volatile : room).emit(SERVER_EVENTS.stream, frame);
}

/** One dispatcher's streams: their seeds, the handles that push to them, and their socket listeners. */
export interface Streams {
  /**
   * The handle of stream `name` of `contract`'s service on this dispatcher.
   * Throws a `TypeError` when the dispatcher does not serve that stream.
   */
  handle(contract: AnyContract, name: string): StreamHandle<AnyContract, string>;
  /** Serves `qd:stream:sub` and `qd:stream:unsub` on a v5 socket. */
  readonly extension: ReturnType<typeof streamSubscriptions>;
}

/** Creates the streams of the dispatcher whose hub this is. */
export function createStreams(hub: Hub): Streams {
  const seeds = new StreamSeeds();
  return Object.freeze({
    handle(contract: AnyContract, name: string): StreamHandle<AnyContract, string> {
      const served = servedStream(hub, contract, name);
      return Object.freeze({
        push: (...args: unknown[]) => {
          push(hub, seeds, served, args);
        },
      }) as StreamHandle<AnyContract, string>;
    },
    extension: streamSubscriptions(hub, seeds),
  });
}
