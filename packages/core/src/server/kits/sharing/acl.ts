// The sharing kit's access list methods (RFC 0003 section 12.3, mode
// `"acl"`): `share`, `shareByName`, `unshare`, `setLevel` and `listShares`,
// on the list of the service's `jsonAcl` policy (`aclList.ts`). A change
// reads the row's list (and owner) and writes it back with
// `db.<model>.update` in one SERIALIZABLE transaction (`runtime.ts`); the
// tracked write evicts the cached access of the row and revokes the live
// subscriptions that lost it. A change:
//
// - first reads the caller's own level on the row again, inside the
//   transaction: `FORBIDDEN` when it no longer meets the method's form, or
//   when the change would give a level above it (`checks.ts`);
// - never touches the owner's access, which the owner column gives:
//   `CONFLICT`;
// - never leaves a row without an Admin it had (no owner column, the last
//   `Admin` entry unshared or lowered, and no Admin from another policy of
//   an `anyOf`, `admins.ts`): `CONFLICT`;
// - refuses a malformed list (`CONFLICT`), leaving it as it is;
// - writes nothing when the user already has exactly that level.
//
// `share` adds the user or replaces their level; `setLevel` and `unshare`
// need the user in the list (`NOT_FOUND`). Each returns the list as
// `listShares` does: `[{ userId, level }]`, one entry per user.
//
// Statements, inside the transaction: the caller's level (the policy's
// reads; none with a service-wide `Admin` grant), one read of the row, then
// (for a change) the tracked update, which reads the old access columns
// first. `listShares` is one.

import type { ACE } from "../../../contract/access";
import type { IdInput } from "../../../contract/kits/crudSchemas";
import type {
  ShareByNameQuery,
  ShareInput,
  ShareLevel,
  UnshareInput,
} from "../../../contract/kits/sharingSchemas";
import { QuickdrawError } from "../../../protocol/errors";
import type { KitHandler, KitHandlerArgs, ModelDelegate } from "../crud/runtime";
import {
  entriesOf,
  hasAdmin,
  levelIn,
  parseList,
  sharesOf,
  withLevel,
  type StoredEntry,
} from "./aclList";
import { adminElsewhere, capGrant, checkCaller } from "./checks";
import { resolveTarget, type HandlerContext } from "./context";
import { aclColumnsOf } from "./policy";
import { inSerializable, notifyChange, sharingCall, tableOf, type SharingCall } from "./runtime";

/** The access list a mode `"acl"` method changes: its column, and its owner column. */
type JsonAclColumns = ReturnType<typeof aclColumnsOf>;

/** One change to a row's access list. */
interface AclChange {
  readonly kind: "share" | "unshare" | "setLevel";
  readonly id: string;
  readonly userId: string;
  /** The level to give the user, or `null` to take theirs away. */
  readonly level: ShareLevel | null;
  /** Whether the list must already hold the user (`setLevel`, `unshare`). */
  readonly listed: boolean;
}

/** The row's list and owner. */
interface Listed {
  readonly entries: readonly StoredEntry[];
  /** The owner's user id, when the policy names an owner column and the row holds one. */
  readonly owner: string | undefined;
}

async function readList(
  table: ModelDelegate,
  columns: JsonAclColumns,
  id: string,
  model: string,
): Promise<Listed> {
  const select = {
    id: true,
    [columns.field]: true,
    ...(columns.owner === undefined ? {} : { [columns.owner]: true }),
  };
  const row = await table.findUnique({ where: { id }, select });
  if (row === null) {
    throw new QuickdrawError("NOT_FOUND", `No such ${model}`);
  }
  const entries = parseList(row[columns.field]);
  if (entries === undefined) {
    throw new QuickdrawError(
      "CONFLICT",
      `The access list in ${model}.${columns.field} is malformed, so the sharing kit leaves it as it is: it must be a list of { userId, level }`,
    );
  }
  const owner = columns.owner === undefined ? undefined : row[columns.owner];
  return { entries, owner: typeof owner === "string" && owner.length > 0 ? owner : undefined };
}

/** Why `change` may not be made to `listed`, as the error to throw; `undefined` when it may. */
function refusal(listed: Listed, change: AclChange, model: string): QuickdrawError | undefined {
  if (listed.owner === change.userId) {
    return new QuickdrawError(
      "CONFLICT",
      `That user owns this ${model}: an owner's access cannot be shared, changed or taken away`,
    );
  }
  if (change.listed && levelIn(listed.entries, change.userId) === null) {
    return new QuickdrawError("NOT_FOUND", `This ${model} is not shared with that user`);
  }
  return undefined;
}

/**
 * `CONFLICT` when `change` takes away the row's last Admin: the list (and its
 * owner) had one and would have none, and no other policy of the service
 * gives one (`admins.ts`), read through `tx`.
 */
async function checkLastAdmin(
  call: SharingCall,
  tx: unknown,
  listed: Listed,
  change: AclChange,
): Promise<void> {
  const next = withLevel(listed.entries, change.userId, change.level);
  const losing = hasAdmin(listed.entries, listed.owner) && !hasAdmin(next, listed.owner);
  const { service } = call.runtime;
  if (losing && !(await adminElsewhere(service, tx, change.id, aclColumnsOf(service)))) {
    throw new QuickdrawError(
      "CONFLICT",
      `That user is the last Admin of this ${call.model}; give someone else Admin first`,
    );
  }
}

/** Makes `change` to the row's list, and returns the list as it is afterwards. */
async function changeList(
  call: SharingCall,
  context: HandlerContext,
  change: AclChange,
): Promise<ACE[]> {
  const columns = aclColumnsOf(call.runtime.service);
  return await inSerializable(call.db, async (tx) => {
    capGrant(await checkCaller(call, context.form, change.id), change.level, call.model);
    const table = tableOf(tx, call.model);
    const listed = await readList(table, columns, change.id, call.model);
    const problem = refusal(listed, change, call.model);
    if (problem !== undefined) {
      throw problem;
    }
    await checkLastAdmin(call, tx, listed, change);
    const before = levelIn(listed.entries, change.userId);
    if (before === change.level && entriesOf(listed.entries, change.userId) === 1) {
      return sharesOf(listed.entries);
    }
    const next = withLevel(listed.entries, change.userId, change.level);
    await table.update({
      where: { id: change.id },
      data: { [columns.field]: next },
      select: { id: true },
    });
    const { kind, id, userId, level } = change;
    await notifyChange(context.onChange, call, { kind, id, userId, before, after: level }, tx);
    return sharesOf(next);
  });
}

/** The `share` handler: gives the user the level, whatever they had. */
export function shareHandler(context: HandlerContext): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<ACE[]> => {
    const { id, userId, level } = input as ShareInput;
    const change = { kind: "share", id, userId, level, listed: false } as const;
    return await changeList(sharingCall(ctx, db), context, change);
  };
  return handler as KitHandler;
}

/** The `shareByName` handler: `share`, for the user `resolveUser` finds. */
export function shareByNameHandler(context: HandlerContext): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<ACE[]> => {
    const { id, name, email, level } = input as ShareByNameQuery;
    const call = sharingCall(ctx, db);
    const userId = await resolveTarget(call, context, { name, email });
    return await changeList(call, context, { kind: "share", id, userId, level, listed: false });
  };
  return handler as KitHandler;
}

/** The `setLevel` handler: changes the level of a user the list holds. */
export function setLevelHandler(context: HandlerContext): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<ACE[]> => {
    const { id, userId, level } = input as ShareInput;
    const change = { kind: "setLevel", id, userId, level, listed: true } as const;
    return await changeList(sharingCall(ctx, db), context, change);
  };
  return handler as KitHandler;
}

/** The `unshare` handler: takes the user's entries out of the list. */
export function unshareHandler(context: HandlerContext): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<ACE[]> => {
    const { id, userId } = input as UnshareInput;
    const change = { kind: "unshare", id, userId, level: null, listed: true } as const;
    return await changeList(sharingCall(ctx, db), context, change);
  };
  return handler as KitHandler;
}

/** The `listShares` handler: the row's list, one entry per user. */
export function listSharesHandler(): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<ACE[]> => {
    const call = sharingCall(ctx, db);
    const columns = aclColumnsOf(call.runtime.service);
    const table = tableOf(call.db, call.model);
    const { id } = input as IdInput;
    return sharesOf((await readList(table, columns, id, call.model)).entries);
  };
  return handler as KitHandler;
}
