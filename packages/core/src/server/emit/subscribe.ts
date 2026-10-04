// One `qd:sub` batch (RFC 0003 sections 4.3 and 6). It replaces 4.1's
// `subscribe` and `batchSubscribe` (`legacy-src/server/BaseService.ts:176-283`),
// which joined a row's rooms before reading the row (`:204-213`, `:252-264`),
// so a socket could sit in the room of a row that did not exist. Here a batch
// goes, in this order:
//
// 1. authorize every id in one engine call, which also gives the rows each
//    level is anchored on; an id below `Read` is `FORBIDDEN` and never read;
// 2. take the revision before any row is read: the last one taken, so reads
//    do not push revisions ahead of the clock (`currentRev`); behind a
//    cluster's counter, the counter's last one (`cluster/revisions.ts`);
// 3. find which held rows are unchanged ("not modified"): one narrow read of
//    the service's `versionColumn`, or the change log;
// 4. read the other allowed rows in one `findMany` with the entity
//    projection's select;
// 5. put the socket in the room of each row found, for its level, and record
//    the subscription and its anchors on `socket.data`;
// 6. settle the races: an access change while the batch ran re-resolves the
//    joined rows, and a flush that touched a joined row after the revision
//    (its frame may have gone out before the join) re-reads that row (behind
//    a cluster's counter, any flush on any node: every joined row). Then,
//    while access keeps changing, the joined rows are resolved again, at most
//    `MAX_RECHECKS` times; a row whose anchors were still moving is denied.
//    A subscription the batch recorded and someone else ended meanwhile
//    (revocation, a disconnect) is `FORBIDDEN`; one someone else replaced (a
//    newer resolution) is answered at that one's level;
// 7. answer each id: its row stripped for its level, "not modified", or why
//    not.
//
// Revocation finds a socket through the anchors its subscriptions record, so
// an access change made after a row was joined with its current anchors
// reaches the batch's subscription by itself; the rechecks cover changes
// made before that, on anchors the batch had not recorded yet.

import type { EntityResult, Revision } from "../../protocol/envelope";
import { currentRev } from "../rev";
import type { StorageRow } from "../storage";
import type { QuickdrawServerSocket } from "../transports/types";
import type { Hub, LiveService } from "./hub";
import { projectRow } from "./projection";
import { anchorsOf, resolveAccess, subscriberLevel } from "./resolve";
import type { EntitySubscription } from "./subscriptions";
import { strip } from "./tiers";
import { rowVersions, unchangedRows } from "./versions";

/** How often a subscribe resolves access again after its reads, while access keeps changing. */
export const MAX_RECHECKS = 3;

/** A `qd:sub` frame, read. */
export interface SubscribeRequest {
  readonly s: string;
  /** The ids, in request order; an id may repeat. */
  readonly ids: readonly string[];
  /** The revision the client holds, for each id it sent one for. */
  readonly held: ReadonlyMap<string, Revision>;
}

/** One answered id: its level, the row read (none for "not modified"), and the revision. */
interface Answer {
  readonly level: EntitySubscription["level"];
  readonly row: StorageRow | undefined;
  readonly rev: Revision;
}

interface Batch {
  readonly hub: Hub;
  readonly socket: QuickdrawServerSocket;
  readonly target: LiveService;
  readonly principal: NonNullable<QuickdrawServerSocket["data"]["principal"]>;
  /** The access changes the process had seen when the batch last resolved access. */
  checkedAt: number;
  /** Per id, how often the socket had unsubscribed from it when the batch began. */
  readonly unsubscribes: ReadonlyMap<string, number>;
  readonly denied: Set<string>;
  readonly answers: Map<string, Answer>;
  /** The subscription the batch recorded for each row it joined, while the batch manages it. */
  readonly joined: Map<string, EntitySubscription>;
  /** The joined rows whose level or anchors the last recheck changed. */
  moving: ReadonlySet<string>;
}

const FORBIDDEN: EntityResult = Object.freeze({
  ok: false,
  e: Object.freeze({ code: "FORBIDDEN", message: "Insufficient permissions" }),
});

const NOT_FOUND: EntityResult = Object.freeze({
  ok: false,
  e: Object.freeze({ code: "NOT_FOUND", message: "No such row" }),
});

/** The rows `ids`, read in one query with the entity projection's select. */
async function readRows(
  hub: Hub,
  target: LiveService,
  ids: readonly string[],
): Promise<Map<string, StorageRow>> {
  const projection = target.service.projections.get("entity");
  if (ids.length === 0 || projection === undefined || hub.storage === undefined) {
    return new Map();
  }
  const rows = await hub.storage.findMany(target.model, {
    where: { id: { in: [...ids] } },
    select: projection.select,
  });
  return new Map(rows.flatMap((row) => (typeof row.id === "string" ? [[row.id, row]] : [])));
}

/** True while the socket's subscription to the row is still the one the batch recorded. */
function isOwn(batch: Batch, id: string): boolean {
  const own = batch.joined.get(id);
  const current = batch.hub.subscriptions.get(batch.socket, batch.target.service.name, id);
  return own !== undefined && current === own;
}

/**
 * True while the batch may put the socket in the row's room: the socket is
 * still connected (a socket indexed after its disconnect would stay in the
 * index forever), and the client has not unsubscribed from the row since the
 * batch began.
 */
function joinable(batch: Batch, id: string): boolean {
  const { hub, socket, target } = batch;
  const unsubscribes = hub.subscriptions.unsubscribes(socket, target.service.name, id);
  return socket.connected && unsubscribes === batch.unsubscribes.get(id);
}

/** Step 5: joins the room of each answered row the socket may still join (`joinable`). */
function join(batch: Batch, anchors: (id: string) => readonly string[]): void {
  const { hub, socket, target } = batch;
  const service = target.service.name;
  for (const [id, answer] of batch.answers) {
    if (!joinable(batch, id)) {
      continue;
    }
    const subscription: EntitySubscription = { level: answer.level, anchors: anchors(id) };
    hub.subscriptions.set(socket, service, id, subscription);
    batch.joined.set(id, subscription);
  }
}

/** Gives up a joined row the socket may no longer join; the answer stands, as for a row never joined. */
function abandon(batch: Batch, id: string): void {
  if (isOwn(batch, id)) {
    batch.hub.subscriptions.delete(batch.socket, batch.target.service.name, id);
  }
  batch.joined.delete(id);
}

/** Ends a subscription the batch made, and answers the id with `result`; another's is left alone. */
function retract(batch: Batch, id: string, result: "denied" | "missing"): void {
  if (isOwn(batch, id)) {
    batch.hub.subscriptions.delete(batch.socket, batch.target.service.name, id);
  }
  batch.joined.delete(id);
  batch.answers.delete(id);
  if (result === "denied") {
    batch.denied.add(id);
  }
}

/**
 * A joined row whose subscription is no longer the batch's. Ended by
 * someone else (revocation, a disconnect): `FORBIDDEN`, unless the client
 * unsubscribed, which leaves the answer as it was. Replaced by a newer
 * resolution (revocation's, or another batch's): answered at its level.
 */
function release(batch: Batch, id: string): void {
  const { hub, socket, target } = batch;
  const service = target.service.name;
  const current = hub.subscriptions.get(socket, service, id);
  const answer = batch.answers.get(id);
  batch.joined.delete(id);
  if (current !== undefined) {
    if (answer !== undefined) {
      batch.answers.set(id, { ...answer, level: current.level });
    }
    return;
  }
  if (hub.subscriptions.unsubscribes(socket, service, id) === batch.unsubscribes.get(id)) {
    batch.answers.delete(id);
    batch.denied.add(id);
  }
}

/** Releases every joined row whose subscription someone else ended or replaced. */
function releaseTaken(batch: Batch): void {
  for (const id of [...batch.joined.keys()]) {
    if (!isOwn(batch, id)) {
      release(batch, id);
    }
  }
}

function sameSubscription(a: EntitySubscription | undefined, b: EntitySubscription): boolean {
  return (
    a !== undefined &&
    a.level === b.level &&
    a.anchors.length === b.anchors.length &&
    a.anchors.every((anchor, index) => anchor === b.anchors[index])
  );
}

/** True when access changed since the batch last resolved it. */
function accessMoved(batch: Batch): boolean {
  return batch.hub.subscriptions.accessChanges !== batch.checkedAt;
}

/** Step 6: access changed since the batch last resolved it, so the joined rows are resolved again. */
async function recheckAccess(batch: Batch): Promise<void> {
  const { hub, target, principal, socket } = batch;
  if (!accessMoved(batch)) {
    return;
  }
  batch.checkedAt = hub.subscriptions.accessChanges;
  batch.moving = new Set();
  if (batch.joined.size === 0) {
    return;
  }
  const service = target.service.name;
  const ids = [...batch.joined.keys()];
  const access = await resolveAccess(hub, target.service, principal, ids);
  const moving = new Set<string>();
  for (const id of ids) {
    if (!isOwn(batch, id)) {
      release(batch, id);
      continue;
    }
    // The guards `join` applies, since this may join the row's room again.
    if (!joinable(batch, id)) {
      abandon(batch, id);
      continue;
    }
    const level = subscriberLevel(access, id);
    const answer = batch.answers.get(id);
    if (level === undefined || answer === undefined) {
      retract(batch, id, "denied");
      continue;
    }
    const subscription: EntitySubscription = { level, anchors: anchorsOf(access, service, id) };
    if (!sameSubscription(batch.joined.get(id), subscription)) {
      moving.add(id);
      hub.subscriptions.set(socket, service, id, subscription);
      batch.joined.set(id, subscription);
      batch.answers.set(id, { ...answer, level });
    }
  }
  batch.moving = moving;
}

/**
 * The joined rows a flush may have touched after the revision, and the
 * revision to read them again at. This process's change log names them; it
 * sees only this process's flushes, so behind a cluster's counter every
 * joined row is read again once any node took a revision after `rev`.
 */
async function touchedSince(
  batch: Batch,
  rev: Revision,
): Promise<{ readonly stale: string[]; readonly fresh: Revision }> {
  const { hub, target } = batch;
  const joined = [...batch.joined.keys()];
  if (hub.revisions.shared()) {
    const moved = await hub.revisions.movedPast(rev);
    return { stale: moved === undefined ? [] : joined, fresh: moved ?? rev };
  }
  const service = target.service.name;
  const stale = joined.filter((id) => hub.changeLog.lastChange(service, id) > rev);
  return { stale, fresh: stale.length === 0 ? rev : currentRev() };
}

/** Step 6: rows a flush touched after the revision are read again, at the newer one. */
async function rereadTouched(batch: Batch, rev: Revision): Promise<void> {
  const { hub, target } = batch;
  const { stale, fresh } = await touchedSince(batch, rev);
  if (stale.length === 0) {
    return;
  }
  const rows = await readRows(hub, target, stale);
  for (const id of stale) {
    const row = rows.get(id);
    const answer = batch.answers.get(id);
    if (row === undefined || answer === undefined) {
      retract(batch, id, "missing");
      continue;
    }
    batch.answers.set(id, { level: answer.level, row, rev: fresh });
  }
}

/** Step 6. */
async function settleRaces(batch: Batch, rev: Revision): Promise<void> {
  await recheckAccess(batch);
  await rereadTouched(batch, rev);
  for (let round = 0; round < MAX_RECHECKS && accessMoved(batch); round += 1) {
    await recheckAccess(batch);
  }
  if (accessMoved(batch)) {
    // Access changed during the last check too: a row it gave new anchors may have missed a change on them.
    for (const id of batch.moving) {
      if (batch.joined.has(id)) {
        retract(batch, id, "denied");
      }
    }
  }
  releaseTaken(batch);
}

/** Steps 1 to 5. */
async function answerBatch(batch: Batch, held: ReadonlyMap<string, Revision>): Promise<Revision> {
  const { hub, target, principal } = batch;
  const service = target.service.name;
  const ids = [...batch.unsubscribes.keys()];
  const access = await resolveAccess(hub, target.service, principal, ids);
  const allowed = new Set(ids.filter((id) => subscriberLevel(access, id) !== undefined));
  for (const id of ids) {
    if (!allowed.has(id)) {
      batch.denied.add(id);
    }
  }
  const claimed = hub.revisions.claim();
  const rev = typeof claimed === "number" ? claimed : await claimed;
  const heldAllowed = new Map([...held].filter(([id]) => allowed.has(id)));
  const versions = await rowVersions(hub, target.service, [...heldAllowed.keys()]);
  const unchanged = unchangedRows(versions, heldAllowed);
  const toRead = [...allowed].filter((id) => !unchanged.has(id) && !versions.missing.has(id));
  const rows = await readRows(hub, target, toRead);
  for (const id of allowed) {
    const level = subscriberLevel(access, id);
    const row = rows.get(id);
    if (level !== undefined && (row !== undefined || unchanged.has(id))) {
      batch.answers.set(id, { level, row, rev });
    }
  }
  join(batch, (id) => anchorsOf(access, service, id));
  return rev;
}

function resultOf(batch: Batch, id: string): EntityResult {
  if (batch.denied.has(id)) {
    return FORBIDDEN;
  }
  const found = batch.answers.get(id);
  if (found === undefined) {
    return NOT_FOUND;
  }
  if (found.row === undefined) {
    return { ok: true, nm: true, rev: found.rev };
  }
  const projection = batch.target.service.projections.get("entity");
  const data = projection === undefined ? found.row : projectRow(projection, found.row);
  const hidden = projection?.tiers.hidden(found.level);
  const isRow = typeof data === "object" && data !== null && hidden !== undefined;
  return {
    ok: true,
    d: isRow ? strip(data as Readonly<Record<string, unknown>>, hidden) : data,
    rev: found.rev,
  };
}

/**
 * Answers one `qd:sub` batch of a socket with a principal, one result per
 * requested id in request order. Rejects when a lookup or read fails; the
 * subscriptions the batch made are then ended.
 */
export async function subscribe(
  hub: Hub,
  socket: QuickdrawServerSocket,
  target: LiveService,
  request: SubscribeRequest,
): Promise<EntityResult[]> {
  const { principal } = socket.data;
  if (principal === null) {
    throw new TypeError("subscribe: the socket has no principal");
  }
  const service = target.service.name;
  const batch: Batch = {
    hub,
    socket,
    target,
    principal,
    checkedAt: hub.subscriptions.accessChanges,
    unsubscribes: hub.subscriptions.begin(socket, service, request.ids),
    denied: new Set(),
    answers: new Map(),
    joined: new Map(),
    moving: new Set(),
  };
  try {
    const rev = await answerBatch(batch, request.held);
    await settleRaces(batch, rev);
  } catch (error) {
    for (const id of [...batch.joined.keys()]) {
      retract(batch, id, "missing");
    }
    throw error;
  } finally {
    hub.subscriptions.end(socket, service, request.ids);
  }
  return request.ids.map((id) => resultOf(batch, id));
}
