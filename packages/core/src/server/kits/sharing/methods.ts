// The handler of each sharing kit method (RFC 0003 section 12.3), and the
// access form each runs under unless `sharing.handlers` is given another: a
// change needs `Admin` on the row, a list `Read`, and `leave` a signed-in
// caller (the handler then checks they are a member). The forms name the row
// by the input key each mode uses: `id`, or `entryId`.

import type { SharingMethodName } from "../../../contract/kits/sharing";
import type { AccessForm } from "../../access/types";
import type { KitHandler } from "../crud/runtime";
import {
  listSharesHandler,
  setLevelHandler,
  shareByNameHandler,
  shareHandler,
  unshareHandler,
} from "./acl";
import type { HandlerContext } from "./context";
import { listMembersHandler } from "./listMembers";
import {
  inviteByNameHandler,
  inviteHandler,
  leaveHandler,
  removeHandler,
  setRoleHandler,
} from "./members";

const ADMIN_ROW: AccessForm = Object.freeze({ entry: "Admin" });
const ADMIN_ENTRY: AccessForm = Object.freeze({ entry: "Admin", id: "entryId" });
const READ_ROW: AccessForm = Object.freeze({ entry: "Read" });
const READ_ENTRY: AccessForm = Object.freeze({ entry: "Read", id: "entryId" });

/** The form each sharing kit method runs under when `access` gives none. */
export const DEFAULT_ACCESS: Readonly<Record<SharingMethodName, AccessForm>> = Object.freeze({
  share: ADMIN_ROW,
  shareByName: ADMIN_ROW,
  unshare: ADMIN_ROW,
  setLevel: ADMIN_ROW,
  listShares: READ_ROW,
  invite: ADMIN_ENTRY,
  inviteByName: ADMIN_ENTRY,
  remove: ADMIN_ENTRY,
  setRole: ADMIN_ENTRY,
  listMembers: READ_ENTRY,
  leave: "authenticated",
});

const MAKERS: Readonly<Record<SharingMethodName, (context: HandlerContext) => KitHandler>> =
  Object.freeze({
    share: shareHandler,
    shareByName: shareByNameHandler,
    unshare: unshareHandler,
    setLevel: setLevelHandler,
    listShares: listSharesHandler,
    invite: inviteHandler,
    inviteByName: inviteByNameHandler,
    remove: removeHandler,
    leave: leaveHandler,
    setRole: setRoleHandler,
    listMembers: listMembersHandler,
  });

/** The handler of one sharing kit method: a new function for each, which `defineService` checks. */
export function handlerOf(method: SharingMethodName, context: HandlerContext): KitHandler {
  return MAKERS[method](context);
}
