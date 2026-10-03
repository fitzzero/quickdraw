// Revocation (RFC 0003 section 4.4). Each live subscription records the rows
// its level is derived from: its anchors. When a flush may have changed
// someone's level on an anchor (`dispatcher.access.onAccessChanged`), the
// subscriptions anchored there are resolved again, for the user the change
// names or for everyone:
//
// - below `Read` now: the socket leaves the row's room and gets
//   `qd:revoked { kind: "entity", reason: "access", s, id }`; a row the flush
//   deleted is left alone, since its own removal frame (`r`) goes out next;
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

import { SERVER_EVENTS, userRoom } from "../../contract/names";
import type { AccessChange } from "../access/changes";
import { describeError } from "../pipeline/metrics";
import { currentRev } from "../rev";
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
  const rev = currentRev();
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

/** Ends a subscription the principal may no longer read, unless the flush deleted the row. */
function revoke(hub: Hub, socket: QuickdrawServerSocket, service: string, id: string): void {
  if (hub.changeLog.removed(service, id)) {
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
      revoke(hub, socket, service, id);
      continue;
    }
    hub.subscriptions.set(socket, service, id, { level, anchors: anchorsOf(access, service, id) });
    if (seesOther(hub, service, level, subscription.level)) {
      moved.push(id);
    }
  }
  await resend(hub, socket, service, moved);
}

/** Resolves the given subscriptions again, one engine call per socket and service. */
async function reresolveAll(
  hub: Hub,
  found: ReadonlyMap<QuickdrawServerSocket, Entries>,
): Promise<void> {
  const work: Promise<void>[] = [];
  for (const [socket, entries] of found) {
    const byService = new Map<string, SubscriptionEntry[]>();
    for (const entry of entries) {
      byService.set(entry.service, [...(byService.get(entry.service) ?? []), entry]);
    }
    for (const [service, own] of byService) {
      work.push(reresolve(hub, socket, service, own));
    }
  }
  await Promise.all(work);
}

/** What the subscriptions of a dispatcher do when access changes. */
export interface Revocation {
  /**
   * Re-resolves the subscriptions `change` concerns on this process. A change
   * this process flushed (`remote` false) is first broadcast to the other
   * nodes, behind a cluster adapter.
   */
  changed(change: AccessChange, remote: boolean): Promise<void>;
  /** Re-resolves every subscription of `userId`'s sockets on this process: their grants changed. */
  regranted(userId: string): Promise<void>;
}

/** The revocation of one dispatcher's subscriptions. */
export function createRevocation(hub: Hub): Revocation {
  return Object.freeze({
    async changed(change: AccessChange, remote: boolean): Promise<void> {
      hub.subscriptions.accessChanges += 1;
      const { io } = hub;
      if (!remote && io !== undefined && !hub.probe.local()) {
        io.serverSideEmit(ACCESS_CHANGED_EVENT, change);
      }
      await reresolveAll(hub, hub.subscriptions.matching(change));
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
      await reresolveAll(hub, found);
    },
  });
}
