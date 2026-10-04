// The sharing kit's `listMembers` (RFC 0003 section 12.3): one page of a
// row's members from the table of the service's `members` policy, each as
// `{ userId, role, level }`, by the read/write kit's keyset page
// (`kits/crud/page.ts`). Members come in user id order (then the membership
// row's id), so a page boundary stays put when members join or leave before
// it; the kit knows no other column of the table to order by. One statement.

import type { OrderBy } from "../../../contract/collections";
import type { ListMembersQuery, MembersPage } from "../../../contract/kits/sharingSchemas";
import { modelKey } from "../../storage";
import { readPage } from "../crud/page";
import type { KitHandler, KitHandlerArgs } from "../crud/runtime";
import { membershipTableOf } from "./policy";
import { memberOf } from "./roles";
import { sharingCall, tableOf } from "./runtime";

/** The `listMembers` handler. */
export function listMembersHandler(): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<MembersPage> => {
    const call = sharingCall(ctx, db);
    const read = membershipTableOf(call.runtime.service);
    const query = input as ListMembersQuery;
    const order: OrderBy = [
      [read.user, "asc"],
      ["id", "asc"],
    ];
    const page = await readPage({
      table: tableOf(call.db, read.model),
      model: modelKey(read.model),
      storage: call.runtime.storage,
      where: { [read.entry]: query.entryId },
      order,
      cursor: query.cursor,
      limit: query.limit,
      select: { id: true, [read.user]: true, [read.level]: true },
      totalCount: false,
      filtered: false,
    });
    return {
      items: page.rows.map((row) => memberOf(read, row[read.user], row[read.level])),
      nextCursor: page.nextCursor,
    };
  };
  return handler as KitHandler;
}
