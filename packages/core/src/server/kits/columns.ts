// The columns a kit write may set (RFC 0003 sections 4.2, 4.4 and 12). A
// write of the read/write kit (`update`, `bulkUpdate`) or of the admin kit
// (`adminCreate`, `adminUpdate`) that names a column deciding who may reach
// the row would hand its caller access the policy never gave them: a member
// making themselves the owner, or a row moved into a project its mover
// cannot open. So, unless the caller holds a service-wide `Admin` grant
// (with `adminBypass`), which writes any column:
//
// - a column the service's policy reads (an owner column, an access list) is
//   read-only;
// - a column that places the row under an anchor row (an `inherit` policy's
//   `via`, an anchored collection's scope column) may move it only into an
//   anchor row on which the caller's level, from that row's own policy (as
//   `inherit` and collection scopes count it, without grants on its
//   service), meets the method's row level. Setting it to null moves the row
//   out of every anchor, which needs nothing more.
//
// Statements: one engine call per anchor column the write sets (the anchor
// policy's reads), none otherwise.

import type { AccessLevel } from "../../contract/access";
import { QuickdrawError } from "../../protocol/errors";
import { meetsLevel, serviceGrant } from "../access/levels";
import type { KitRuntime } from "../context";
import type { AnyService } from "../service";
import type { Principal } from "../types";

/** A column whose value is the id of an anchor row, and the service that row belongs to. */
interface AnchorColumn {
  readonly column: string;
  readonly anchor: string;
}

/** The columns of a service's rows that decide who may reach them. */
interface GuardedColumns {
  /** Read-only unless the caller holds a service-wide `Admin` grant. */
  readonly locked: ReadonlySet<string>;
  /** Writable into an anchor row the caller has the method's row level on. */
  readonly anchors: readonly AnchorColumn[];
}

function guardedColumns(service: AnyService): GuardedColumns {
  const reads = service.access?.reads;
  const anchors = new Map<string, AnchorColumn>();
  const add = (column: string, anchor: string): void => {
    anchors.set(`${column}\u0000${anchor}`, { column, anchor });
  };
  for (const { from, via } of reads?.parents ?? []) {
    add(via, from.name);
  }
  for (const collection of service.collections.values()) {
    if (collection.anchor !== undefined && collection.scope.kind === "column") {
      add(collection.scope.column, collection.anchor.name);
    }
  }
  const moving = new Set([...anchors.values()].map(({ column }) => column));
  const locked = (reads?.columns ?? []).filter((column) => column !== "id" && !moving.has(column));
  return { locked: new Set(locked), anchors: [...anchors.values()] };
}

function forbidden(message: string): QuickdrawError {
  return new QuickdrawError("FORBIDDEN", message);
}

/** True when the principal's service-wide `Admin` grant passes every check on the service. */
function bypasses(service: AnyService, principal: Principal | null): boolean {
  return (
    principal !== null && service.adminBypass && serviceGrant(principal, service.name) === "Admin"
  );
}

/**
 * `FORBIDDEN` unless the caller may set every column `data` gives a value
 * (`undefined` is no value), in a write whose rows need `level`: no column
 * the policy reads, and each anchor column only to an anchor row the caller
 * has `level` on (or null).
 */
export async function checkWritableColumns(
  runtime: Pick<KitRuntime, "service" | "access">,
  principal: Principal | null,
  data: Readonly<Record<string, unknown>>,
  level: AccessLevel,
): Promise<void> {
  const { service, access } = runtime;
  if (bypasses(service, principal)) {
    return;
  }
  const { locked, anchors } = guardedColumns(service);
  const named = new Set(Object.keys(data).filter((column) => data[column] !== undefined));
  const readOnly = [...named].find((column) => locked.has(column));
  if (readOnly !== undefined) {
    throw forbidden(
      `"${readOnly}" decides who may reach rows of ${service.name}: only a service-wide Admin may change it`,
    );
  }
  for (const { column, anchor } of anchors) {
    const target = data[column];
    if (!named.has(column) || target === null) {
      continue;
    }
    const valid = principal !== null && typeof target === "string" && target.length > 0;
    const resolved = valid
      ? await access.resolve(anchor, principal, [target], { grants: false })
      : undefined;
    if (resolved === undefined || !meetsLevel(resolved.levels.get(target as string), level)) {
      throw forbidden(
        `Moving a row of ${service.name} by "${column}" needs ${level} on the ${anchor} row it moves into`,
      );
    }
  }
}
