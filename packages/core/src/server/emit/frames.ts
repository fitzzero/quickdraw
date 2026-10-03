// Entity frames (RFC 0003 section 6), all on the event `qd:e`:
//
// | Write                                                  | Frame | Payload             |
// |--------------------------------------------------------|-------|---------------------|
// | delete                                                 | `r`   | none                |
// | create                                                 | `u`   | the full projection |
// | update of plain projection fields only (no `map`)      | `p`   | the changed fields  |
// | any other update: unknown fields (a touch, `affects`), | `u`   | the full projection |
// | a field outside the projection, a projection with `map`|       |                     |
//
// A create is never a patch: a patch of a row the client never had could not
// be applied. A patch also carries the service's `versionColumn` when the
// projection has it, since tracked writes do not report `@updatedAt` columns.
// Every frame of a flush carries the flush's revision.

import type { EntityFrame, Revision } from "../../protocol/envelope";
import type { StorageRow } from "../storage";
import { ANY_FIELD } from "../uow/types";
import type { Touch } from "./affects";
import { pickKeys, projectRow, type Projection } from "./projection";

/** How a touched row goes out: whole, as a patch of `fields`, or as a removal. */
export type FrameKind =
  | { readonly t: "u" }
  | { readonly t: "p"; readonly fields: readonly string[] }
  | { readonly t: "r" };

const WHOLE: FrameKind = Object.freeze({ t: "u" });

const REMOVED: FrameKind = Object.freeze({ t: "r" });

/** The frame a row's touch makes; see the table above. */
export function frameKind(
  projection: Projection,
  touch: Touch,
  versionColumn: string | undefined,
): FrameKind {
  if (touch.op === "delete") {
    return REMOVED;
  }
  const { fields } = touch;
  const plain =
    touch.op === "update" &&
    projection.map === undefined &&
    fields.length > 0 &&
    !fields.includes(ANY_FIELD) &&
    fields.every((field) => projection.keys.includes(field));
  if (!plain) {
    return WHOLE;
  }
  const patched = new Set(fields);
  if (versionColumn !== undefined && projection.keys.includes(versionColumn)) {
    patched.add(versionColumn);
  }
  patched.delete("id");
  return patched.size === 0 ? WHOLE : { t: "p", fields: [...patched] };
}

/**
 * What one read of a flush's rows selects: the projection's own select when
 * any row goes out whole, and only the patched fields when every row is a
 * patch, so a row is read no wider than what is sent.
 */
export function selectFor(
  projection: Projection,
  kinds: readonly FrameKind[],
): Readonly<Record<string, unknown>> {
  if (kinds.some((kind) => kind.t === "u")) {
    return projection.select;
  }
  const select: Record<string, true> = { id: true };
  for (const kind of kinds) {
    if (kind.t === "p") {
      for (const field of kind.fields) {
        select[field] = true;
      }
    }
  }
  return select;
}

/** The frame of one row, before tiers are stripped: `row` is the row read, absent for a removal. */
export function buildFrame(
  service: string,
  id: string,
  kind: FrameKind,
  row: StorageRow | undefined,
  rev: Revision,
  projection: Projection,
): EntityFrame | undefined {
  if (kind.t === "r") {
    return { t: "r", s: service, id, rev };
  }
  if (row === undefined) {
    return undefined;
  }
  if (kind.t === "p") {
    return { t: "p", s: service, id, rev, d: pickKeys(row, kind.fields) };
  }
  return { t: "u", s: service, id, rev, d: projectRow(projection, row) };
}
