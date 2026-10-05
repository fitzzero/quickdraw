// Which rows a flush touched, per service (RFC 0003 section 5.3, steps 1 and
// 3). A write to a model touches its row in every service declaring that
// model; then each service's `affects` adds the rows its written rows point
// at, one hop and without duplicates: a task written with `affects: [{
// service: task, id: "parentTaskId" }]` touches its parent task as well, which
// is then sent whole. 4.1 left this to lifecycle hooks and hand-written emits
// (4.1 `src/server/BaseService.ts:741-827`).

import type { Registry } from "../registry";
import type { AffectsLink, AnyService } from "../service";
import { modelKey, type StorageAdapter } from "../storage";
import { ANY_FIELD, type WriteRecord } from "../uow/types";

/** What a flush did to one row of one service. */
export interface Touch {
  readonly op: WriteRecord["op"];
  /** The fields written; `[ANY_FIELD]` when they are unknown, as for a touch or an affected row. */
  readonly fields: readonly string[];
}

/** The rows a flush touched, by service, then by row id. */
export type TouchedRows = ReadonlyMap<AnyService, ReadonlyMap<string, Touch>>;

/** How writes find services: by model, and through each `affects` link. */
export interface Routes {
  /** The services declaring each model, by the client's model name. */
  readonly byModel: ReadonlyMap<string, readonly AnyService[]>;
  /** The service each `affects` link points at. */
  readonly targets: ReadonlyMap<AffectsLink, AnyService>;
}

function fail(message: string): never {
  throw new TypeError(`createDispatcher: ${message}`);
}

function targetOf(registry: Registry, service: AnyService, link: AffectsLink): AnyService {
  const target = registry.services.get(link.service.name);
  if (target === undefined) {
    fail(`${service.name} affects ${link.service.name}, which this dispatcher does not serve`);
  }
  if (target.model === undefined || target.contract.entity === undefined) {
    fail(
      `${service.name} affects ${target.name}, which has no model and entity, so it has no rows to send again`,
    );
  }
  return target;
}

/**
 * The routes of `registry`'s services. Registers each `affects` link's
 * columns with the storage adapter, so writes report them. Throws a
 * `TypeError` for a link to a service this dispatcher cannot send rows of.
 */
export function routesOf(registry: Registry, storage: StorageAdapter | undefined): Routes {
  const byModel = new Map<string, AnyService[]>();
  const targets = new Map<AffectsLink, AnyService>();
  for (const service of registry.services.values()) {
    if (service.model === undefined) {
      continue;
    }
    const key = modelKey(service.model);
    byModel.set(key, [...(byModel.get(key) ?? []), service]);
    for (const link of service.affects) {
      targets.set(link, targetOf(registry, service, link));
      storage?.registerInterest(key, link.columns);
    }
  }
  return { byModel, targets };
}

type Touched = Map<AnyService, Map<string, Touch>>;

function rowsOf(touched: Touched, service: AnyService): Map<string, Touch> {
  let rows = touched.get(service);
  if (rows === undefined) {
    rows = new Map();
    touched.set(service, rows);
  }
  return rows;
}

/** The ids a written row points at through `link`: before and after the write. */
function linkedIds(link: AffectsLink, write: WriteRecord): Set<string> {
  const ids = new Set<string>();
  for (const values of [write.before, write.after]) {
    for (const id of values === undefined ? [] : link.ids(values)) {
      ids.add(id);
    }
  }
  return ids;
}

/** Marks the rows `write` affects through `service`'s links: sent whole, unless the flush deleted them. */
function affect(touched: Touched, routes: Routes, service: AnyService, write: WriteRecord): void {
  for (const link of service.affects) {
    const target = routes.targets.get(link);
    const ids = linkedIds(link, write);
    if (target === undefined || ids.size === 0) {
      continue;
    }
    const rows = rowsOf(touched, target);
    for (const id of ids) {
      const touch = rows.get(id);
      if (touch?.op !== "delete") {
        rows.set(id, { op: touch?.op ?? "update", fields: [ANY_FIELD] });
      }
    }
  }
}

/** The rows `writes` touched per service, `affects` expanded one hop. */
export function touchedRows(writes: readonly WriteRecord[], routes: Routes): TouchedRows {
  const touched: Touched = new Map();
  for (const write of writes) {
    for (const service of routes.byModel.get(modelKey(write.model)) ?? []) {
      rowsOf(touched, service).set(write.id, { op: write.op, fields: write.fields });
    }
  }
  for (const write of writes) {
    for (const service of routes.byModel.get(modelKey(write.model)) ?? []) {
      affect(touched, routes, service, write);
    }
  }
  return touched;
}
