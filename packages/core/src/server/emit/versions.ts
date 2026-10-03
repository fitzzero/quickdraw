// Row versions for "not modified" answers (RFC 0003 sections 6 and 9, step 5).
// A row's version is the time in its service's `versionColumn` when the
// service declares one (read in one narrow query), or else the revision of
// the last flush the in-process change log saw touch it. The version is taken
// before the row itself is read, so an answer is never older than the version
// it claims.
//
// - A call to a query whose output is one projection row (`"entity"`,
//   `nullable("card")`) and whose input has an `id` gets that row's version,
//   when the row it returns is that row: a caller that sends it back as `v`
//   gets `{ ok: true, nm: true, v }` while the row is unchanged. A query
//   keyed by another id (the latest task of project `id`) returns some other
//   row, whose changes that version does not follow, and gets none. This is
//   the dispatcher's default `versions`.
// - `qd:sub` answers "not modified" for an id whose held revision is no
//   older than the row's version.

import type { Revision } from "../../protocol/envelope";
import type { VersionSource } from "../pipeline/notModified";
import type { AnyService } from "../service";
import { usableChangeLog, versionTime, type Hub } from "./hub";

/** The versions of some rows of a service. */
export interface RowVersions {
  /** Each row's version; a row without one is absent. */
  readonly versions: ReadonlyMap<string, number>;
  /** Rows the version column's read found missing; empty when nothing was read. */
  readonly missing: ReadonlySet<string>;
}

const NONE: RowVersions = Object.freeze({
  versions: new Map<string, number>(),
  missing: new Set<string>(),
});

/**
 * The versions of `ids` of `service`: from its `versionColumn` in one query,
 * or from the change log (behind a cluster adapter it has none), or none.
 */
export async function rowVersions(
  hub: Hub,
  service: AnyService,
  ids: readonly string[],
): Promise<RowVersions> {
  const { model, versionColumn } = service;
  if (ids.length === 0 || model === undefined) {
    return NONE;
  }
  if (versionColumn === undefined) {
    const log = usableChangeLog(hub);
    return log === undefined
      ? NONE
      : {
          versions: new Map(ids.map((id) => [id, log.lastChange(service.name, id)])),
          missing: new Set(),
        };
  }
  const rows =
    (await hub.storage?.findMany(model, {
      where: { id: { in: [...ids] } },
      select: { id: true, [versionColumn]: true },
    })) ?? [];
  const versions = new Map<string, number>();
  for (const row of rows) {
    const time = versionTime(row[versionColumn]);
    if (typeof row.id === "string" && time !== undefined) {
      versions.set(row.id, time);
    }
  }
  const found = new Set(rows.map((row) => row.id));
  return { versions, missing: new Set(ids.filter((id) => !found.has(id))) };
}

/** The ids whose held revision is no older than their row's version: "not modified". */
export function unchangedRows(
  versions: RowVersions,
  held: ReadonlyMap<string, Revision>,
): Set<string> {
  const unchanged = new Set<string>();
  for (const [id, rev] of held) {
    const version = versions.versions.get(id);
    if (version !== undefined && version <= rev) {
      unchanged.add(id);
    }
  }
  return unchanged;
}

function inputId(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const { id } = input as { readonly id?: unknown };
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * The dispatcher's default `versions`: the version of the row a query
 * returns, for a query whose output is one projection row and whose input
 * has an `id`, attached only when the row returned is row `id`. Any other
 * query has none, and always runs.
 */
export function createVersionSource(hub: Hub): VersionSource {
  return Object.freeze({
    async versionOf({ service, method, input }) {
      const id = inputId(input);
      if (
        id === undefined ||
        method.projection === undefined ||
        method.projection.kind === "list"
      ) {
        return undefined;
      }
      const { versions } = await rowVersions(hub, service, [id]);
      return versions.get(id);
    },
    describes({ input }, result) {
      const id = inputId(input);
      const returned =
        typeof result === "object" && result !== null
          ? (result as { readonly id?: unknown }).id
          : undefined;
      return id !== undefined && returned === id;
    },
  } satisfies VersionSource);
}
