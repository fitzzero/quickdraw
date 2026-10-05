// The entity sinks (RFC 0003 sections 5.3 and 6): what a flush does for
// entity subscribers. It replaces 4.1's `emitUpdate`
// (4.1 `src/server/BaseService.ts:454-466`), which only `this.update` and
// hand-written code called.
//
// Two sinks, on either side of the access sink on the dispatcher's list:
//
// - `intake` works out which rows of which services the flush touched
//   (`affects` included) and records them in the change log, before access
//   is evicted and revoked, so revocation knows a deleted row from a
//   forbidden one;
// - `emit` runs once revocation has moved or removed sockets, so a socket
//   whose access the flush removed never gets its frames. Per service with
//   touched rows it skips rows whose rooms are all empty, reads the rest in
//   one query with the entity projection's select (a patch reads only the
//   patched fields), builds each frame once and strips it once per group of
//   occupied tiers that see the same fields.
//
// Room occupancy is read from this process's adapter. Behind a cluster
// adapter (Redis) other nodes' rooms are invisible, so every touched row is
// read and its frame sent to every tier. Frames sent there go out whole
// (`u`, never `p`): frames from two nodes can reach a client out of revision
// order, and a patch it dropped as older would lose its fields, while an
// older whole row is rightly dropped (the newer one was read after the older
// write). A tier that would have got an empty patch still gets nothing.
//
// Behind a cluster adapter a deleted row is read too: a flush takes its
// revision when it flushes, so a delete that committed first can flush after
// a later create of the same id, and its `r` would win over that row on the
// client. A row this flush deleted that exists at the read goes out whole
// (`u`) instead, and the change log records it as existing. One server keeps
// sending `r` without a read.

import type { AccessLevel } from "../../contract/access";
import { entityRoom, SERVER_EVENTS } from "../../contract/names";
import type { EntityFrame, Revision } from "../../protocol/envelope";
import type { AnyService } from "../service";
import type { FlushInfo, FlushSink } from "../uow/flushSink";
import type { WriteRecord } from "../uow/types";
import { touchedRows, type Touch, type TouchedRows } from "./affects";
import { buildFrame, frameKind, selectFor, type FrameKind } from "./frames";
import type { Hub } from "./hub";
import { strip, SUBSCRIBER_LEVELS } from "./tiers";

type Io = NonNullable<Hub["io"]>;

/** A touched row with subscribers: how it goes out, and the rooms of the tiers it goes to. */
interface Target {
  readonly id: string;
  readonly kind: FrameKind;
  readonly rooms: ReadonlyMap<AccessLevel, string>;
  /** Behind a cluster adapter, the fields a patch would have carried: the row goes out whole. */
  readonly patched?: readonly string[];
}

const WHOLE: FrameKind = Object.freeze({ t: "u" });

/** How a row goes out: as `frameKind` says, but whole instead of a patch behind a cluster adapter. */
function targetOf(
  id: string,
  kind: FrameKind,
  rooms: ReadonlyMap<AccessLevel, string>,
  local: boolean,
): Target {
  return local || kind.t !== "p"
    ? { id, kind, rooms }
    : { id, kind: WHOLE, rooms, patched: kind.fields };
}

/** True when the tier sees none of the fields the write changed: it gets no frame, as it would get no patch. */
function seesNoChange(target: Target, hidden: ReadonlySet<string>): boolean {
  return target.patched !== undefined && target.patched.every((field) => hidden.has(field));
}

/** The tier rooms of a row that have subscribers here; behind a cluster adapter, every tier room. */
function occupiedRooms(
  io: Io,
  service: string,
  id: string,
  local: boolean,
): Map<AccessLevel, string> {
  const rooms = new Map<AccessLevel, string>();
  const known = io.sockets.adapter.rooms;
  for (const level of SUBSCRIBER_LEVELS) {
    const room = entityRoom(service, id, level);
    if (!local || (known.get(room)?.size ?? 0) > 0) {
      rooms.set(level, room);
    }
  }
  return rooms;
}

/** Sends a frame to its rooms: a removal once to all, data once per group of tiers that see the same fields. */
function send(io: Io, frame: EntityFrame, target: Target, service: AnyService): void {
  if (frame.t === "r") {
    io.to([...target.rooms.values()]).emit(SERVER_EVENTS.entity, frame);
    return;
  }
  const tiers = service.projections.get("entity")?.tiers;
  for (const group of tiers?.groups ?? []) {
    const rooms = group.levels.flatMap((level) => target.rooms.get(level) ?? []);
    const data = strip(frame.d as Readonly<Record<string, unknown>>, group.hidden);
    const empty =
      frame.t === "p" ? Object.keys(data).length === 0 : seesNoChange(target, group.hidden);
    if (rooms.length === 0 || empty) {
      continue;
    }
    io.to(rooms).emit(SERVER_EVENTS.entity, { ...frame, d: data });
  }
}

/** Reads the rows of `targets` that need data, in one query: behind a cluster adapter, removed rows too. */
async function readTargets(
  hub: Hub,
  service: AnyService,
  targets: readonly Target[],
  local: boolean,
): Promise<Map<string, Readonly<Record<string, unknown>>>> {
  const projection = service.projections.get("entity");
  const reading = local ? targets.filter((target) => target.kind.t !== "r") : targets;
  if (projection === undefined || service.model === undefined || reading.length === 0) {
    return new Map();
  }
  const rows =
    (await hub.storage?.findMany(service.model, {
      where: { id: { in: reading.map((target) => target.id) } },
      select: selectFor(
        projection,
        reading.map((target) => (target.kind.t === "r" ? WHOLE : target.kind)),
      ),
    })) ?? [];
  return new Map(rows.flatMap((row) => (typeof row.id === "string" ? [[row.id, row]] : [])));
}

/** One service's frames for one flush. */
async function emitService(
  hub: Hub,
  io: Io,
  service: AnyService,
  touched: ReadonlyMap<string, Touch>,
  rev: Revision,
): Promise<void> {
  const projection = service.projections.get("entity");
  if (projection === undefined || service.model === undefined) {
    return;
  }
  const local = hub.probe.local();
  const targets: Target[] = [];
  for (const [id, touch] of touched) {
    const rooms = occupiedRooms(io, service.name, id, local);
    if (rooms.size > 0) {
      targets.push(targetOf(id, frameKind(projection, touch, service.versionColumn), rooms, local));
    }
  }
  if (targets.length === 0) {
    return;
  }
  const rows = await readTargets(hub, service, targets, local);
  for (const target of targets) {
    const row = rows.get(target.id);
    // Behind a cluster adapter, a row this flush deleted that exists at the read was created
    // again by a write whose flush went first: it goes out whole, not removed.
    const again = target.kind.t === "r" && row !== undefined;
    if (again) {
      hub.changeLog.record(service.name, target.id, rev, false);
    }
    // A row read as missing was deleted since: its own flush sends the removal.
    const kind = again ? WHOLE : target.kind;
    const frame = buildFrame(service.name, target.id, kind, row, rev, projection);
    if (frame !== undefined) {
      send(io, frame, target, service);
    }
  }
}

/** The intake and emit sinks of a dispatcher's entity subscriptions. */
export function createEntitySinks(hub: Hub): { intake: FlushSink; emit: FlushSink } {
  const flushes = new WeakMap<readonly WriteRecord[], TouchedRows>();
  return {
    intake: Object.freeze({
      flush(writes: readonly WriteRecord[], info: FlushInfo): Promise<void> {
        const touched = touchedRows(writes, hub.routes);
        flushes.set(writes, touched);
        for (const [service, rows] of touched) {
          for (const [id, touch] of rows) {
            hub.changeLog.record(service.name, id, info.rev, touch.op === "delete");
          }
        }
        return Promise.resolve();
      },
    }),
    emit: Object.freeze({
      async flush(writes: readonly WriteRecord[], info: FlushInfo): Promise<void> {
        const { io } = hub;
        if (io === undefined) {
          return;
        }
        const touched = flushes.get(writes) ?? touchedRows(writes, hub.routes);
        await Promise.all(
          [...touched].map(([service, rows]) => emitService(hub, io, service, rows, info.rev)),
        );
      },
    }),
  };
}
