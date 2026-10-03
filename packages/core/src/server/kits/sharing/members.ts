// The sharing kit's membership methods (RFC 0003 section 12.3, mode
// `"members"`): `invite`, `inviteByName`, `remove`, `leave` and `setRole`,
// on the table of the service's `members` policy. Each change creates,
// updates or deletes membership rows through the tracked client, in one
// SERIALIZABLE transaction (`runtime.ts`): the flush evicts the member's
// cached level, revokes the live subscriptions they lost, and sends the
// `via` collections over the table `added` or `removed`.
//
// - `invite` refuses a user who is a member already (`CONFLICT`; `setRole`
//   changes a role) and gives the lowest readable role when none is given.
//   An invitee the database does not know (a foreign key) is `NOT_FOUND`.
// - `remove` and `setRole` need the user to be a member (`NOT_FOUND`);
//   `leave` is for members only (`FORBIDDEN` for anyone else).
// - The last Admin member of a row cannot leave, be removed or lose Admin
//   (`CONFLICT`): whether another member has Admin is read in the same
//   transaction as the change. Only this table's members count; an owner
//   column or an access list in an `anyOf` is not part of it.
//
// Statements, inside the transaction: one read of the member's rows (of
// whether they are one, for `invite`), one more for whether another member
// has Admin when the change takes Admin away, and the write (a tracked
// `create` or `delete` is one; `setRole`'s `updateMany` reads the old roles
// first: two).

import type {
  InviteByNameQuery,
  InviteQuery,
  LeaveInput,
  Member,
  MemberInput,
  SetRoleInput,
} from "../../../contract/kits/sharingSchemas";
import { QuickdrawError } from "../../../protocol/errors";
import type { MembershipRead } from "../../access/policy";
import type { KitHandler, KitHandlerArgs, ModelDelegate, Row } from "../crud/runtime";
import { resolveTarget, type HandlerContext } from "./context";
import { membershipTableOf } from "./policy";
import { adminRolesOf, checkRole, currentRole, levelOfRole, memberOf } from "./roles";
import { inSerializable, notifyChange, sharingCall, tableOf, type SharingCall } from "./runtime";

/** Whom a membership change is about. */
interface Target {
  readonly entryId: string;
  readonly userId: string;
}

async function rowsOf(table: ModelDelegate, read: MembershipRead, target: Target): Promise<Row[]> {
  return await table.findMany({
    where: { [read.entry]: target.entryId, [read.user]: target.userId },
    select: { id: true, [read.level]: true },
  });
}

/** True when a member other than the target has `Admin` on the row. */
async function anotherAdmin(
  table: ModelDelegate,
  read: MembershipRead,
  target: Target,
): Promise<boolean> {
  const roles = adminRolesOf(read);
  const found =
    roles.length === 0
      ? null
      : await table.findFirst({
          where: {
            [read.entry]: target.entryId,
            [read.user]: { not: target.userId },
            [read.level]: { in: roles },
          },
          select: { id: true },
        });
  return found !== null;
}

function lastAdmin(model: string): QuickdrawError {
  return new QuickdrawError(
    "CONFLICT",
    `That user is the last Admin member of this ${model}; make another member Admin first`,
  );
}

function isForeignKeyFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "PrismaClientKnownRequestError" &&
    (error as Error & { readonly code?: unknown }).code === "P2003"
  );
}

/** Makes the target a member with `role`. */
async function invite(
  call: SharingCall,
  context: HandlerContext,
  target: Target,
  role: string | undefined,
): Promise<Member> {
  const read = membershipTableOf(call.runtime.service);
  const given = checkRole(read, role);
  return await inSerializable(call.db, async (tx) => {
    const table = tableOf(tx, read.model);
    if ((await rowsOf(table, read, target)).length > 0) {
      throw new QuickdrawError(
        "CONFLICT",
        `That user is a member of this ${call.model} already; setRole changes a member's role`,
      );
    }
    try {
      await table.create({
        data: { [read.entry]: target.entryId, [read.user]: target.userId, [read.level]: given },
        select: { id: true },
      });
    } catch (error) {
      if (!isForeignKeyFailure(error)) {
        throw error;
      }
      const missing = new QuickdrawError("NOT_FOUND", `No such user, or no such ${call.model}`);
      missing.cause = error;
      throw missing;
    }
    const { entryId: id, userId } = target;
    const change = { kind: "invite", id, userId, before: null, after: given } as const;
    await notifyChange(context.onChange, call, change, tx);
    return memberOf(read, userId, given);
  });
}

/** Ends the target's membership: `remove` by an Admin, or `leave` by the member. */
async function end(
  call: SharingCall,
  context: HandlerContext,
  target: Target,
  kind: "remove" | "leave",
): Promise<null> {
  const read = membershipTableOf(call.runtime.service);
  return await inSerializable(call.db, async (tx) => {
    const table = tableOf(tx, read.model);
    const rows = await rowsOf(table, read, target);
    if (rows.length === 0) {
      throw kind === "leave"
        ? new QuickdrawError("FORBIDDEN", `You are not a member of this ${call.model}`)
        : new QuickdrawError("NOT_FOUND", `That user is not a member of this ${call.model}`);
    }
    const current = currentRole(read, rows);
    if (current.level === "Admin" && !(await anotherAdmin(table, read, target))) {
      throw lastAdmin(call.model);
    }
    const [only, ...more] = rows.map((row) => row.id);
    await (only !== undefined && more.length === 0
      ? table.delete({ where: { id: only }, select: { id: true } })
      : table.deleteMany({ where: { id: { in: [only, ...more] } } }));
    const change = { kind, id: target.entryId, userId: target.userId, after: null };
    await notifyChange(context.onChange, call, { ...change, before: current.role }, tx);
    return null;
  });
}

/** Gives the target member `role`. */
async function changeRole(
  call: SharingCall,
  context: HandlerContext,
  target: Target,
  role: string,
): Promise<Member> {
  const read = membershipTableOf(call.runtime.service);
  checkRole(read, role);
  return await inSerializable(call.db, async (tx) => {
    const table = tableOf(tx, read.model);
    const rows = await rowsOf(table, read, target);
    if (rows.length === 0) {
      throw new QuickdrawError("NOT_FOUND", `That user is not a member of this ${call.model}`);
    }
    const current = currentRole(read, rows);
    if (rows.length === 1 && current.role === role) {
      return memberOf(read, target.userId, role);
    }
    const demoted = current.level === "Admin" && levelOfRole(read, role) !== "Admin";
    if (demoted && !(await anotherAdmin(table, read, target))) {
      throw lastAdmin(call.model);
    }
    await table.updateMany({
      where: { [read.entry]: target.entryId, [read.user]: target.userId },
      data: { [read.level]: role },
    });
    const { entryId: id, userId } = target;
    const change = { kind: "setRole", id, userId, before: current.role, after: role } as const;
    await notifyChange(context.onChange, call, change, tx);
    return memberOf(read, userId, role);
  });
}

/** The `invite` handler. */
export function inviteHandler(context: HandlerContext): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<Member> => {
    const { entryId, userId, role } = input as InviteQuery;
    return await invite(sharingCall(ctx, db), context, { entryId, userId }, role);
  };
  return handler as KitHandler;
}

/** The `inviteByName` handler: `invite`, for the user `resolveUser` finds. */
export function inviteByNameHandler(context: HandlerContext): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<Member> => {
    const { entryId, name, email, role } = input as InviteByNameQuery;
    const call = sharingCall(ctx, db);
    const userId = await resolveTarget(call, context, { name, email });
    return await invite(call, context, { entryId, userId }, role);
  };
  return handler as KitHandler;
}

/** The `remove` handler. */
export function removeHandler(context: HandlerContext): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<null> => {
    const { entryId, userId } = input as MemberInput;
    return await end(sharingCall(ctx, db), context, { entryId, userId }, "remove");
  };
  return handler as KitHandler;
}

/** The `leave` handler: the caller ends their own membership. */
export function leaveHandler(context: HandlerContext): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<null> => {
    const call = sharingCall(ctx, db);
    if (call.principal === null) {
      throw new QuickdrawError("UNAUTHENTICATED", "Sign in to leave");
    }
    const { entryId } = input as LeaveInput;
    return await end(call, context, { entryId, userId: call.principal.userId }, "leave");
  };
  return handler as KitHandler;
}

/** The `setRole` handler. */
export function setRoleHandler(context: HandlerContext): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<Member> => {
    const { entryId, userId, role } = input as SetRoleInput;
    return await changeRole(sharingCall(ctx, db), context, { entryId, userId }, role);
  };
  return handler as KitHandler;
}
