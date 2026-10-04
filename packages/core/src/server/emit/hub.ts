// What the live-data modules of one dispatcher share (RFC 0003 sections 4.4,
// 5.3 and 6): the services and how writes reach them, the storage adapter
// rows are read through, the policies levels come from, the change log, the
// index of this process's subscriptions, and, once a server attaches it, the
// Socket.IO server frames go out on.

import type { Logger } from "../../contract/logger";
import { QuickdrawError } from "../../protocol/errors";
import type { AccessEngine, PolicyEngine } from "../access/api";
import { createRevisions, type ClusterOptions, type Revisions } from "../cluster/revisions";
import type { Registry } from "../registry";
import type { StorageAdapter } from "../storage";
import type { QuickdrawIo } from "../transports/types";
import { routesOf, type Routes } from "./affects";
import { createChangeLog, type ChangeLog, type ChangeLogOptions } from "./changeLog";
import { SubscriptionIndex } from "./subscriptions";

/** Whether every subscriber of this server is a socket of this process. */
export interface AdapterProbe {
  /**
   * True while the server's Socket.IO adapter is the in-memory one it was
   * created with. Behind a cluster adapter (Redis) rooms on other nodes are
   * not visible here, so room occupancy cannot skip a read, and access
   * changes are broadcast to the other nodes.
   */
  local(): boolean;
}

/** Options of {@link createHub}. */
export interface HubOptions {
  readonly registry: Registry;
  readonly storage: StorageAdapter | undefined;
  readonly policies: PolicyEngine;
  /** The dispatcher's access engine, which decides who may subscribe to a stream. */
  readonly access: AccessEngine;
  readonly logger: Logger;
  /** The change log's options, or `false` for none. */
  readonly changeLog: ChangeLogOptions | false | undefined;
}

/** The live-data state of one dispatcher. */
export interface Hub {
  readonly registry: Registry;
  readonly storage: StorageAdapter | undefined;
  readonly policies: PolicyEngine;
  /** The dispatcher's access engine (RFC 0003 section 4.1): stream subscribers are authorized through it. */
  readonly access: AccessEngine;
  readonly logger: Logger;
  readonly routes: Routes;
  /**
   * The rows recent flushes touched. Always kept: subscriptions use it to
   * tell a deleted row from a forbidden one and to catch a flush racing a
   * subscribe. It answers "not modified" only when `answers` is on.
   */
  readonly changeLog: ChangeLog;
  /** Whether the change log answers "not modified" (the dispatcher's `changeLog` is not `false`). */
  readonly answers: boolean;
  readonly subscriptions: SubscriptionIndex;
  /** The Socket.IO server, once `createServer` attached one. */
  io: QuickdrawIo | undefined;
  probe: AdapterProbe;
  /** `createServer`'s `cluster` option: where the cluster's shared state lives, behind a cluster adapter. */
  cluster: ClusterOptions | undefined;
  /**
   * The revisions flushes take and reads claim: the process's clock, or
   * behind a cluster adapter the cluster's shared counter (`cluster/revisions.ts`).
   */
  readonly revisions: Revisions;
  /**
   * Work started for a socket's event that may still send frames once it
   * settles (a room's presence read from every node): a server's `close()`
   * waits for it, so nothing is sent through an adapter the app is about to
   * close.
   */
  readonly inFlight: Set<Promise<unknown>>;
}

const ALWAYS_LOCAL: AdapterProbe = Object.freeze({ local: () => true });

/** Creates the live-data state of a dispatcher. Throws a `TypeError` for an `affects` it cannot follow. */
export function createHub(options: HubOptions): Hub {
  const hub: Omit<Hub, "revisions"> = {
    registry: options.registry,
    storage: options.storage,
    policies: options.policies,
    access: options.access,
    logger: options.logger,
    routes: routesOf(options.registry, options.storage),
    changeLog: createChangeLog(options.changeLog === false ? undefined : options.changeLog),
    answers: options.changeLog !== false,
    subscriptions: new SubscriptionIndex(),
    io: undefined,
    probe: ALWAYS_LOCAL,
    cluster: undefined,
    inFlight: new Set(),
  };
  return Object.assign(hub, { revisions: createRevisions(hub) });
}

/** Keeps `work` in the hub's work in flight until it settles. */
export function track(hub: Pick<Hub, "inFlight">, work: Promise<unknown>): void {
  hub.inFlight.add(work);
  const done = (): void => {
    hub.inFlight.delete(work);
  };
  work.then(done, done);
}

/** Resolves once the hub's work in flight, and any it started meanwhile, has settled. */
export async function drain(hub: Pick<Hub, "inFlight">): Promise<void> {
  while (hub.inFlight.size > 0) {
    await Promise.allSettled([...hub.inFlight]);
  }
}

/**
 * The change log, when it may answer "not modified": it is on, and, since it
 * sees only this process's writes, the server is not behind a cluster adapter.
 */
export function usableChangeLog(hub: Hub): ChangeLog | undefined {
  return hub.answers && hub.probe.local() ? hub.changeLog : undefined;
}

/** A service the registry holds. */
type RegisteredService = Registry["services"] extends ReadonlyMap<string, infer S> ? S : never;

/** A service whose rows can be subscribed to and sent: it has an entity and a model. */
export interface LiveService {
  readonly service: RegisteredService;
  readonly model: string;
}

/** The service `name` names, if its rows can be sent; `NOT_FOUND` otherwise. */
export function liveService(hub: Hub, name: string): LiveService {
  const service = hub.registry.services.get(name);
  if (service === undefined) {
    throw new QuickdrawError("NOT_FOUND", `Unknown service "${name}"`);
  }
  if (service.model === undefined || service.contract.entity === undefined) {
    throw new QuickdrawError(
      "NOT_FOUND",
      `${name} has no entity rows to subscribe to: it declares no model or its contract no entity`,
    );
  }
  return { service, model: service.model };
}

/** The time a version column holds, in milliseconds, or `undefined` when it holds none. */
export function versionTime(value: unknown): number | undefined {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? undefined : time;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const time = Date.parse(value);
    return Number.isNaN(time) ? undefined : time;
  }
  return undefined;
}
