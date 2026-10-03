// Change topics (RFC 0003 section 11.3): how a query learns that the data it
// read has changed without hand-written event names. A query whose contract
// declares `watch: { collection, scope }` makes the client join the topic
// `{collection}:{scope}` of its service; a query that depends on the whole
// service joins `service`. The server then sends `qd:changed { s, topic, rev
// }` once per flush that changed the topic (`collections/changed.ts`), and
// the client invalidates the query. The frame carries no data: rows travel
// as entity frames and collection deltas, never as a change signal. Topics
// reuse collection scopes, so nothing is declared twice.
//
// `qd:watch { s, topic }` is answered `{ ok: true }` or `{ ok: false, e }`,
// and joins the topic's room. It is authorized, and sends no snapshot:
//
// - `{collection}:{scope}` exactly as `qd:col:sub` of that scope is
//   (`collections/access.ts`): `UNAUTHENTICATED` for an anonymous socket,
//   `FORBIDDEN` for a scope the principal may not subscribe to;
// - `service` by the service's `watchAccess` (`"public"`, `"authenticated"`
//   or `{ service: level }`); without one the topic is closed, `FORBIDDEN`
//   for everyone, since it changes whenever any row of the service does.
//
// A malformed frame is `VALIDATION`, an unknown service or collection (or a
// service without a model, whose rows never change) `NOT_FOUND`.
// `qd:unwatch { s, topic }` is checked the same way, leaves the room,
// optionally acknowledged, and stops a watch still being authorized from
// joining. Neither counts against the socket rate limiter
// (`transports/middleware.ts`), and neither listener throws
// (`emit/answer.ts`). A watch whose access the socket loses leaves its room,
// after one last `qd:changed` (`topicRevocation.ts`).

import { CLIENT_EVENTS, topicRoom } from "../contract/names";
import type { Ok } from "../protocol/envelope";
import { QuickdrawError } from "../protocol/errors";
import { authorizeWatch } from "./collections/access";
import type { CollectionHub } from "./collections/bind";
import { createTopicSink } from "./collections/changed";
import { answerEvent, answerNow, onDisconnect } from "./emit/answer";
import { readWatch, TopicIndex } from "./topicIndex";
import { createTopicRevocation, targetOf } from "./topicRevocation";
import type { QuickdrawServerSocket, SocketContext } from "./transports/types";

/** Serves one `qd:watch`: authorizes it, then joins the topic's room unless the client unwatched meanwhile. */
async function watchTopic(
  hub: CollectionHub,
  index: TopicIndex,
  socket: QuickdrawServerSocket,
  frame: unknown,
): Promise<Ok> {
  const watch = readWatch(frame, CLIENT_EVENTS.watch);
  const target = targetOf(hub, watch);
  if (hub.storage === undefined) {
    throw new QuickdrawError(
      "INTERNAL",
      "Change topics follow tracked writes: pass db as trackPrisma(prisma)",
    );
  }
  const room = topicRoom(watch.s, watch.topic);
  const unwatches = index.begin(socket, room);
  try {
    const anchors = await authorizeWatch(hub, socket.data.principal, target);
    if (socket.connected && index.unwatches(socket, room) === unwatches) {
      index.watch(socket, { ...watch, anchors });
    }
  } finally {
    index.end(socket, room);
  }
  return { ok: true };
}

/**
 * Serves one `qd:unwatch`: the socket leaves the topic's room. Throws
 * `VALIDATION` for a malformed frame, `NOT_FOUND` for an unknown service or
 * collection, and `UNAUTHENTICATED` for an anonymous socket, which can watch
 * nothing but a public service topic.
 */
function unwatchTopic(
  hub: CollectionHub,
  index: TopicIndex,
  socket: QuickdrawServerSocket,
  frame: unknown,
): Ok {
  const watch = readWatch(frame, CLIENT_EVENTS.unwatch);
  const target = targetOf(hub, watch);
  const open = target.kind === "service" && target.service.watchAccess === "public";
  if (socket.data.principal === null && !open) {
    throw new QuickdrawError("UNAUTHENTICATED", "Authentication required");
  }
  index.unwatch(socket, topicRoom(watch.s, watch.topic));
  return { ok: true };
}

/** The change topics of one dispatcher. */
export interface Topics {
  /** Sends `qd:changed` for the flush's topics: after the collection sink on the dispatcher's list. */
  readonly sink: ReturnType<typeof createTopicSink>;
  /** Serves `qd:watch` and `qd:unwatch` on every v5 socket. */
  readonly extension: (socket: QuickdrawServerSocket, context: SocketContext) => void;
  /** Authorizes watches again on access changes: a watch a socket lost leaves its room (`topicRevocation.ts`). */
  readonly revocation: ReturnType<typeof createTopicRevocation>;
}

/** Creates the change topics of a dispatcher whose hub holds its collections. */
export function createTopics(hub: CollectionHub): Topics {
  const index = new TopicIndex();
  return Object.freeze({
    sink: createTopicSink(hub, index),
    revocation: createTopicRevocation(hub, index),
    extension: (socket: QuickdrawServerSocket, context: SocketContext): void => {
      answerEvent(socket, context, CLIENT_EVENTS.watch, (frame) =>
        watchTopic(hub, index, socket, frame),
      );
      socket.on(CLIENT_EVENTS.unwatch, (frame: unknown, ack: unknown) => {
        answerNow(socket, context, CLIENT_EVENTS.unwatch, ack, () =>
          unwatchTopic(hub, index, socket, frame),
        );
      });
      onDisconnect(socket, context, () => {
        index.drop(socket);
      });
    },
  });
}
