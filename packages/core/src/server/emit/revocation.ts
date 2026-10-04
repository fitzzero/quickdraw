// Revocation (RFC 0003 section 4.4). Each live subscription records the rows
// its level is derived from: its anchors. When a flush may have changed
// someone's level on an anchor (`dispatcher.access.onAccessChanged`), the
// subscriptions anchored there are resolved again, for the user the change
// names or for everyone:
//
// - below `Read` now: the socket leaves the row's room and gets
//   `qd:revoked { kind: "entity", reason: "access", s, id }`; a row this
//   process's flush deleted is left alone, since its own removal frame (`r`)
//   goes out next. Its subscribers stay in its room, and a create of that id
//   (reported as an access change too) resolves them again before the new
//   row's first frame;
// - another level: the socket moves to that level's room, and gets the row
//   again (`u`) when the two levels see different fields;
// - a lookup that fails denies, as everywhere else.
//
// In 4.1 a subscriber's tier was fixed when it subscribed and an access
// change took effect on re-subscribe (`legacy-src/server/BaseService.ts:171-175`).
// The access sink runs before the entity sink, so a socket a flush revokes
// never gets that flush's frames.
//
// Several nodes behind a cluster adapter each index their own sockets: a
// node broadcasts every access change it flushes (`serverSideEmit`), and each
// node re-resolves its own sockets. A changed `serviceAccess`
// (`server.access.refresh`) re-resolves the user's subscriptions the same way.
// Collection scopes, change topic watches and stream feeds are authorized
// again alongside, through the hooks they give (`collections/revocation.ts`,
// `topicRevocation.ts`, `realtime/streamRevocation.ts`).

import { SERVER_EVENTS, userRoom } from "../../contract/names";
import type { AccessChange } from "../access/changes";
import { answerOf } from "../cluster/acks";
import { describeError } from "../pipeline/metrics";
import type { QuickdrawServerSocket } from "../transports/types";
import type { Hub } from "./hub";
import { projectRow } from "./projection";
import { anchorsOf, resolveAccess, subscriberLevel } from "./resolve";
import type { SubscriptionEntry } from "./subscriptions";
import { strip } from "./tiers";

/** The server-to-server event an access change is broadcast on behind a cluster adapter. */
export const ACCESS_CHANGED_EVENT = "quickdraw:access-changed";

type Entries = readonly SubscriptionEntry[];

/** Sends rows whose subscriber moved to a level that sees other fields again, whole, at a new revision. */
async function resend(
  hub: Hub,
  socket: QuickdrawServerSocket,
  service: string,
  ids: readonly string[],
): Promise<void> {
  const target = hub.registry.services.get(service);
  const projection = target?.projections.get("entity");
  if (ids.length === 0 || target?.model === undefined || projection === undefined) {
    return;
  }
  // Claimed before the read: behind a cluster's counter, no older than any frame the client holds.
  const rev = await hub.revisions.claim();
  const rows =
    (await hub.storage?.findMany(target.model, {
      where: { id: { in: [...ids] } },
      select: projection.select,
    })) ?? [];
  for (const row of rows) {
    const id = typeof row.id === "string" ? row.id : "";
    const subscription = hub.subscriptions.get(socket, service, id);
    const data = projectRow(projection, row);
    if (subscription !== undefined && typeof data === "object" && data !== null) {
      const hidden = projection.tiers.hidden(subscription.level);
      const d = strip(data as Readonly<Record<string, unknown>>, hidden);
      socket.emit(SERVER_EVENTS.entity, { t: "u", s: service, id, rev, d });
    }
  }
}

/**
 * Ends a subscription the principal may no longer read, unless the row is
 * deleted as far as this process's change log knows: the intake sink records
 * each flush before access is resolved, so a row created again counts as
 * existing. For a change another node broadcast, the log is trusted only
 * when the broadcast carried its row's state (`trustLog`), which was
 * recorded first: otherwise this process's log may be behind that node's
 * writes, and the change is never skipped.
 */
function revoke(
  hub: Hub,
  socket: QuickdrawServerSocket,
  entry: { readonly service: string; readonly id: string },
  trustLog: boolean,
): void {
  const { service, id } = entry;
  if (trustLog && hub.changeLog.removed(service, id)) {
    return;
  }
  if (hub.subscriptions.delete(socket, service, id) !== undefined) {
    socket.emit(SERVER_EVENTS.revoked, { kind: "entity", reason: "access", s: service, id });
  }
}

/** True when two levels see different fields of the service's entity. */
function seesOther(hub: Hub, service: string, a: string, b: string): boolean {
  const tiers = hub.registry.services.get(service)?.projections.get("entity")?.tiers;
  if (tiers === undefined || a === b) {
    return false;
  }
  const group = (level: string) =>
    tiers.groups.findIndex((tier) => tier.levels.some((l) => l === level));
  return group(a) !== group(b);
}

/** The levels of `entries` resolved again, or `undefined` when there is no principal or the lookup failed. */
async function resolveAgain(
  hub: Hub,
  socket: QuickdrawServerSocket,
  service: string,
  entries: Entries,
) {
  const { principal } = socket.data;
  const target = hub.registry.services.get(service);
  if (principal === null || target === undefined) {
    return undefined;
  }
  const ids = entries.map((entry) => entry.id);
  try {
    return await resolveAccess(hub, target, principal, ids);
  } catch (error) {
    hub.logger.error(
      "Resolving subscribers' access again failed; their subscriptions are revoked",
      {
        category: "quickdraw.access",
        service,
        error: describeError(error),
      },
    );
    return undefined;
  }
}

/** Resolves one socket's subscriptions to one service again, and applies the new levels. */
async function reresolve(
  hub: Hub,
  socket: QuickdrawServerSocket,
  service: string,
  entries: Entries,
  trustLog: boolean,
): Promise<void> {
  const access = await resolveAgain(hub, socket, service, entries);
  const moved: string[] = [];
  for (const { id, subscription } of entries) {
    // Unsubscribed, subscribed again or resolved again meanwhile: that is newer than this.
    if (!socket.connected || hub.subscriptions.get(socket, service, id) !== subscription) {
      continue;
    }
    const level = access === undefined ? undefined : subscriberLevel(access, id);
    if (access === undefined || level === undefined) {
      revoke(hub, socket, { service, id }, trustLog);
      continue;
    }
    hub.subscriptions.set(socket, service, id, { level, anchors: anchorsOf(access, service, id) });
    if (seesOther(hub, service, level, subscription.level)) {
      moved.push(id);
    }
  }
  await resend(hub, socket, service, moved);
}

/**
 * Resolves the given subscriptions again, one engine call per socket and
 * service. `trustLog` unless the change came from another node without its
 * row's state.
 */
async function reresolveAll(
  hub: Hub,
  found: ReadonlyMap<QuickdrawServerSocket, Entries>,
  trustLog: boolean,
): Promise<void> {
  const work: Promise<void>[] = [];
  for (const [socket, entries] of found) {
    const byService = new Map<string, SubscriptionEntry[]>();
    for (const entry of entries) {
      byService.set(entry.service, [...(byService.get(entry.service) ?? []), entry]);
    }
    for (const [service, own] of byService) {
      work.push(reresolve(hub, socket, service, own, trustLog));
    }
  }
  await Promise.all(work);
}

/**
 * An access change as it travels between nodes: with its row's state as the
 * flushing node's change log has it (the revision of its last write, and
 * whether that write deleted it), which the receiving node records in its
 * own log before resolving anything.
 */
export interface BroadcastChange extends AccessChange {
  readonly rev?: number;
  readonly removed?: boolean;
}

/** `change` with its row's state from this process's change log, for the other nodes. */
function withRowState(hub: Hub, change: AccessChange): BroadcastChange {
  const { service, id } = change;
  if (id === undefined) {
    return change;
  }
  return {
    ...change,
    rev: hub.changeLog.lastChange(service, id),
    removed: hub.changeLog.removed(service, id),
  };
}

/**
 * Broadcasts a change this process flushed and waits until every other node
 * has re-resolved what it concerns (each answers once it is done), at most
 * `cluster.timeoutMs`: the access sinks run before the frame sinks, so a
 * flush that revokes a subscription on another node sends that flush's
 * frames only once the subscription is gone there too. The wait holds this
 * node's later flushes too, so it is skipped while Valkey is not connected,
 * and after a node failed to answer in time until every node answers a
 * probe again (`../cluster/broadcasts.ts`): the frames then go out at once,
 * and a slower node may still hold a socket the change revoked.
 */
async function broadcastChange(hub: Hub, change: BroadcastChange): Promise<void> {
  await hub.broadcasts?.broadcast(ACCESS_CHANGED_EVENT, change);
}

/** What the subscriptions of a dispatcher do when access changes. */
export interface Revocation {
  /**
   * Re-resolves the subscriptions `change` concerns on this process. A change
   * this process flushed (`remote` false) is also broadcast to the other
   * nodes, behind a cluster adapter, with its row's state, and resolves once
   * they re-resolved theirs too (`broadcastChange`).
   */
  changed(change: BroadcastChange, remote: boolean): Promise<void>;
  /** Re-resolves every subscription of `userId`'s sockets on this process: their grants changed. */
  regranted(userId: string): Promise<void>;
}

/** More subscriptions an access change re-resolves: the collection scopes, the change topics, the stream feeds. */
export interface RevocationHook {
  /** Re-resolves the subscriptions `change` concerns on this process. */
  changed(change: AccessChange): Promise<void>;
  /** Re-resolves every subscription of these sockets, whose user's grants changed. */
  regranted(sockets: readonly QuickdrawServerSocket[]): Promise<void>;
}

/**
 * The revocation of one dispatcher's subscriptions; `hooks` re-resolve the
 * collection scopes and the change topics alongside.
 */
export function createRevocation(hub: Hub, hooks: readonly RevocationHook[] = []): Revocation {
  return Object.freeze({
    async changed(change: BroadcastChange, remote: boolean): Promise<void> {
      hub.subscriptions.accessChanges += 1;
      const others =
        !remote && hub.io !== undefined && !hub.probe.local()
          ? broadcastChange(hub, withRowState(hub, change))
          : undefined;
      const trustLog = !remote || change.removed !== undefined;
      await Promise.all([
        others,
        reresolveAll(hub, hub.subscriptions.matching(change), trustLog),
        ...hooks.map(async (hook) => await hook.changed(change)),
      ]);
    },
    async regranted(userId: string): Promise<void> {
      hub.subscriptions.accessChanges += 1;
      const { io } = hub;
      const found = new Map<QuickdrawServerSocket, Entries>();
      for (const socketId of io?.sockets.adapter.rooms.get(userRoom(userId)) ?? []) {
        const socket = io?.sockets.sockets.get(socketId);
        if (socket?.data.principal?.userId === userId) {
          found.set(socket, [...hub.subscriptions.entries(socket)]);
        }
      }
      const sockets = [...found.keys()];
      await Promise.all([
        reresolveAll(hub, found, true),
        ...hooks.map(async (hook) => await hook.regranted(sockets)),
      ]);
    },
  });
}

/** The row state a broadcast change carries, `{ rev, removed }`, when both are well formed. */
function rowStateOf(value: Readonly<Record<string, unknown>>): Partial<BroadcastChange> {
  const { rev, removed } = value;
  return Number.isSafeInteger(rev) && typeof removed === "boolean"
    ? { rev: rev as number, removed }
    : {};
}

/**
 * The access change another node broadcast, `{ service, id?, userId? }` with
 * its row's state when it names a row, or `undefined` for anything else.
 */
function readChange(value: unknown): BroadcastChange | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const fields = value as Readonly<Record<string, unknown>>;
  const { service, id, userId } = fields;
  if (typeof service !== "string" || service.length === 0) {
    return undefined;
  }
  const named = typeof id === "string" && id.length > 0;
  return {
    service,
    ...(named ? { id, ...rowStateOf(fields) } : {}),
    ...(typeof userId === "string" && userId.length > 0 ? { userId } : {}),
  };
}

/** Records the row state a broadcast change carries in this process's change log. */
function recordRowState(hub: Hub, change: BroadcastChange): void {
  if (change.id !== undefined && change.rev !== undefined && change.removed !== undefined) {
    hub.changeLog.record(change.service, change.id, change.rev, change.removed);
  }
}

/**
 * Listens for the access changes other nodes broadcast, on the server the
 * hub was given: each records its row's state in this process's change log,
 * has `forget` evict what it names from the access cache (that node's write
 * changed it), is resolved again, and is answered once it is (the flushing
 * node waits for every node's answer before it sends the flush's frames).
 */
export function listenForChanges(
  hub: Hub,
  revocation: Revocation,
  forget: (change: AccessChange) => void,
): void {
  hub.io?.on(ACCESS_CHANGED_EVENT, (broadcast: unknown, ...rest: unknown[]) => {
    const answer = answerOf(rest);
    const change = readChange(broadcast);
    if (change === undefined) {
      answer(false);
      return;
    }
    recordRowState(hub, change);
    forget(change);
    revocation.changed(change, true).then(
      () => {
        answer(true);
      },
      (error: unknown) => {
        answer(false);
        hub.logger.error("Revoking for an access change another node broadcast failed", {
          category: "quickdraw.access",
          service: change.service,
          error: describeError(error),
        });
      },
    );
  });
}
