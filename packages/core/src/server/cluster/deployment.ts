// Deployments sharing one Valkey (the 5.1 audit's RT-2). Valkey pub/sub is
// global across databases, so two deployments on one Valkey (staging and
// production, say) whose adapters share channels hear each other's
// server-to-server events, and up to 5.1.0 each node applied whatever
// arrived: another deployment's reloaded grants (an escalation until the
// socket reconnects), its disconnects, stream items, room removals, access
// changes and unnamed removals.
//
// A deployment is its `cluster.keyPrefix` (default "quickdraw"), which also
// prefixes the cluster's Valkey keys and is `setupRedisAdapter`'s default
// key. The socket server registers it for its `io`; senders tag each
// `quickdraw:*` payload with it (`tagged`, `emitToNodes`); listeners go
// through `onNodeEvent`, which applies an event of its own deployment only:
//
// - an untagged event comes from a node of an earlier quickdraw version
//   (during a rolling deploy, or of another deployment that shares the
//   Valkey and was not upgraded yet, which a node cannot tell apart): it is
//   applied, with one warning per server;
// - a foreign one is not applied, with one error per server; an event that
//   asks for an answer is still answered (`true`, or `null` for presence),
//   so the other deployment's wait ends and it does not go degraded.
//
// The probe (`broadcasts.ts`) is tagged too, but every node answers it
// whatever its tag: it carries nothing and only says "I am up". Tags do not
// separate what the adapter itself carries: room broadcasts and `qd:rotate`
// on a shared adapter key still reach the other deployment's sockets, and a
// node of an earlier version applies anything. One Valkey, or a distinct
// keyPrefix and adapter key, per deployment.

import type { Logger } from "../../contract/logger";
import type { QuickdrawIo } from "../transports/types";
import { answerOf } from "./acks";
import { DEFAULT_KEY_PREFIX } from "./revisions";

/** The key of the deployment in a server-to-server event's payload. */
export const DEPLOYMENT_KEY = "deployment";

const DEPLOYMENTS = new WeakMap<object, string>();

/** What a server logged once about events from other nodes. */
interface Logged {
  untagged: boolean;
  foreign: boolean;
}

const LOGGED = new WeakMap<object, Logged>();

/** Registers `prefix` as the deployment of the server `io`. */
export function registerDeployment(io: object, prefix: string): void {
  DEPLOYMENTS.set(io, prefix);
}

/**
 * Registers the deployment `cluster.keyPrefix` names (default "quickdraw")
 * for the server `io`; a `TypeError` for a prefix that is not a non-empty
 * string.
 */
export function registerClusterDeployment(
  io: object,
  cluster: { readonly keyPrefix?: unknown } | undefined,
): void {
  registerDeployment(io, checkKeyPrefix(cluster));
}

/**
 * The deployment `cluster` names: its `keyPrefix`, "quickdraw" when it has
 * none. Throws for one that is not a non-empty string (`null` included);
 * `createServer` checks it before anything starts.
 */
export function checkKeyPrefix(cluster: { readonly keyPrefix?: unknown } | undefined): string {
  const prefix = cluster?.keyPrefix === undefined ? DEFAULT_KEY_PREFIX : cluster.keyPrefix;
  if (typeof prefix !== "string" || prefix === "") {
    throw new TypeError("createServer: cluster.keyPrefix must be a non-empty string");
  }
  return prefix;
}

/** The deployment of the server `io`: its `cluster.keyPrefix`, "quickdraw" by default. */
export function deploymentOf(io: object): string {
  return DEPLOYMENTS.get(io) ?? DEFAULT_KEY_PREFIX;
}

/** `payload`, tagged with the deployment of the server `io`. */
export function tagged<T extends object>(
  io: object,
  payload: T,
): T & { readonly deployment: string } {
  return { ...payload, [DEPLOYMENT_KEY]: deploymentOf(io) };
}

/** Sends `event` to the other nodes, unanswered, tagged with this server's deployment. */
export function emitToNodes(io: QuickdrawIo, event: string, payload: object): void {
  io.serverSideEmit(event, tagged(io, payload));
}

function loggedOf(io: object): Logged {
  let logged = LOGGED.get(io);
  if (logged === undefined) {
    logged = { untagged: false, foreign: false };
    LOGGED.set(io, logged);
  }
  return logged;
}

/**
 * Listens for `event` from the other nodes of the server `io`, and runs
 * `handler` with its payload and its answer (which does nothing for an event
 * sent unanswered) for an event of this deployment, or one without a
 * deployment (a node of an earlier version: warned once). An event of
 * another deployment is answered `foreign` and not handled (logged once).
 */
export function onNodeEvent(
  io: QuickdrawIo,
  logger: Logger,
  event: string,
  handler: (payload: unknown, answer: (value: unknown) => void) => void,
  foreign: unknown = true,
): void {
  io.on(event, (payload: unknown, ...rest: unknown[]) => {
    const answer = answerOf<unknown>(rest);
    const tag: unknown =
      typeof payload === "object" && payload !== null
        ? (payload as Readonly<Record<string, unknown>>)[DEPLOYMENT_KEY]
        : undefined;
    const logged = loggedOf(io);
    if (tag === undefined) {
      if (!logged.untagged) {
        logged.untagged = true;
        logger.warn(
          `A node sent ${event} without its deployment: a node of an earlier quickdraw version, during a rolling deploy or of another deployment that shares this Valkey and still runs one. Its events are applied, so upgrade every deployment that shares the Valkey; none arrives once every node runs this version`,
          { category: "quickdraw.cluster", event },
        );
      }
      handler(payload, answer);
      return;
    }
    if (tag !== deploymentOf(io)) {
      if (!logged.foreign) {
        logged.foreign = true;
        logger.error(
          `A node of another deployment (cluster.keyPrefix "${String(tag)}") shares this node's Valkey channels: its ${event} and every later event of it are ignored, but its room broadcasts still reach this node's sockets. Give each deployment its own Valkey, or its own cluster.keyPrefix and adapter key (docs/deploying.md)`,
          { category: "quickdraw.cluster", event, deployment: tag },
        );
      }
      answer(foreign);
      return;
    }
    handler(payload, answer);
  });
}
