// One `qd:sub` batch (RFC 0003 sections 4.3 and 6). It replaces 4.1's
// `subscribe` and `batchSubscribe` (`legacy-src/server/BaseService.ts:176-283`),
// which joined a row's rooms before reading the row (`:204-213`, `:252-264`),
// so a socket could sit in the room of a row that did not exist. Here a batch
// goes, in this order:
//
// 1. authorize every id in one engine call, which also gives the rows each
//    level is anchored on; an id below `Read` is `FORBIDDEN` and never read;
// 2. take the revision before any row is read: the last one taken, so reads
//    do not push revisions ahead of the clock (`currentRev`);
// 3. find which held rows are unchanged ("not modified"): one narrow read of
//    the service's `versionColumn`, or the change log;
// 4. read the other allowed rows in one `findMany` with the entity
//    projection's select;
// 5. put the socket in the room of each row found, for its level, and record
//    the subscription and its anchors on `socket.data`;
// 6. settle two races: an access change while the batch ran re-resolves the
//    joined rows, and a flush that touched a joined row after the revision
//    (its frame may have gone out before the join) re-reads that row;
// 7. answer each id: its row stripped for its level, "not modified", or why
//    not.

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
  /** The access changes the process had seen when the batch began. */
  readonly accessChanges: number;
  /** Per id, how often the socket had unsubscribed from it when the batch began. */
  readonly unsubscribes: ReadonlyMap<string, number>;
  readonly denied: Set<string>;
  readonly answers: Map<string, Answer>;
  /** The ids whose rooms the socket joined in this batch. */
  readonly joined: Set<string>;
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

/**
 * Step 5: joins the room of each answered row, unless the socket has gone
 * (a join after its disconnect would stay in the adapter's rooms forever) or
 * the client unsubscribed from the row while the batch ran.
 */
function join(batch: Batch, anchors: (id: string) => readonly string[]): void {
  const { hub, socket, target } = batch;
  const service = target.service.name;
  if (!socket.connected) {
    return;
  }
  for (const [id, answer] of batch.answers) {
    if (hub.subscriptions.unsubscribes(socket, service, id) !== batch.unsubscribes.get(id)) {
      continue;
    }
    hub.subscriptions.set(socket, service, id, { level: answer.level, anchors: anchors(id) });
    batch.joined.add(id);
  }
}

/** Ends a subscription the batch made, and answers the id with `result`. */
function retract(batch: Batch, id: string, result: "denied" | "missing"): void {
  batch.hub.subscriptions.delete(batch.socket, batch.target.service.name, id);
  batch.joined.delete(id);
  batch.answers.delete(id);
  if (result === "denied") {
    batch.denied.add(id);
  }
}

/** Step 6, first race: access changed while the batch ran, so the joined rows are resolved again. */
async function recheckAccess(batch: Batch): Promise<void> {
  const { hub, target, principal } = batch;
  if (hub.subscriptions.accessChanges === batch.accessChanges || batch.joined.size === 0) {
    return;
  }
  const service = target.service.name;
  const ids = [...batch.joined];
  const access = await resolveAccess(hub, target.service, principal, ids);
  for (const id of ids) {
    const level = subscriberLevel(access, id);
    const answer = batch.answers.get(id);
    if (level === undefined || answer === undefined) {
      retract(batch, id, "denied");
      continue;
    }
    hub.subscriptions.set(batch.socket, service, id, {
      level,
      anchors: anchorsOf(access, service, id),
    });
    batch.answers.set(id, { ...answer, level });
  }
}

/** Step 6, second race: rows a flush touched after the revision are read again, at the newer one. */
async function rereadTouched(batch: Batch, rev: Revision): Promise<void> {
  const { hub, target } = batch;
  const service = target.service.name;
  const stale = [...batch.joined].filter((id) => hub.changeLog.lastChange(service, id) > rev);
  if (stale.length === 0) {
    return;
  }
  const fresh = currentRev();
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
  const rev = currentRev();
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
    accessChanges: hub.subscriptions.accessChanges,
    unsubscribes: new Map(
      request.ids.map((id) => [id, hub.subscriptions.unsubscribes(socket, service, id)]),
    ),
    denied: new Set(),
    answers: new Map(),
    joined: new Set(),
  };
  try {
    const rev = await answerBatch(batch, request.held);
    await recheckAccess(batch);
    await rereadTouched(batch, rev);
  } catch (error) {
    for (const id of [...batch.joined]) {
      retract(batch, id, "missing");
    }
    throw error;
  }
  return request.ids.map((id) => resultOf(batch, id));
}
