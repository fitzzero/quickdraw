// The two ways a search reads its page (RFC 0003 section 12.2).
//
// With a condition (the default "contains", or a strategy's `where`): one
// keyset page (`../crud/page.ts`) of the rows that match it, that the
// policy's `accessWhere` lets the caller read at the method's row level and,
// in a scope, that are its members; in the scope collection's order, else by
// id. Statements: the access filter's own reads (none for `owner` and
// `jsonAcl` policies or a service-wide `Admin` grant), the links of a `via`
// scope, then one for the page.
//
// With a strategy's `ids`: the rows of the ranked ids (and, in a scope, its
// members), read in one statement, then only those the caller may read at
// the row level (one batched `levelsFor`), in the strategy's order, as one
// page. The ids come from outside the policy, so they are checked after they
// are read, never trusted. A call whose caller cancelled while the strategy
// looked up its ids stops before reading them.

import type { SearchPage } from "../../../contract/kits/searchSchemas";
import { selectWith } from "../../collections/items";
import { abortError } from "../../pipeline/errors";
import { unreadable } from "../../transports/ack";
import { allowedIds, rowsWhere } from "../crud/access";
import { readPage } from "../crud/page";
import { projectionOf, type Row } from "../crud/runtime";
import type { AnyStrategy, SearchRun } from "./context";
import { allOf, rankedIds, scopeWhere, searchOrder, textWhere } from "./filters";
import { emptyPage, resultsPage } from "./results";

/** Stops a call that its caller cancelled, or that ran out of time, before it reads its rows. */
function stopIfAborted(run: SearchRun): void {
  const { signal } = run.ctx;
  if (signal.aborted) {
    throw abortError(signal);
  }
}

/** One page of the rows a condition matches. */
export async function wherePage(run: SearchRun): Promise<SearchPage<unknown>> {
  const access = await rowsWhere(run.call, run.context.form, run.level);
  if (access === "none") {
    return emptyPage();
  }
  const scope = await scopeWhere(run);
  const text = scope === "none" ? "none" : await textWhere(run);
  if (scope === "none" || text === "none") {
    return emptyPage();
  }
  stopIfAborted(run);
  const projection = projectionOf(run.call, run.context.projection);
  const order = searchOrder(run);
  const page = await readPage({
    table: run.call.table,
    model: run.call.model,
    storage: run.call.runtime.storage,
    where: allOf([text, access, scope]),
    order,
    cursor: run.query.cursor,
    limit: run.query.limit,
    select: selectWith(
      projection.select,
      order.map(([column]) => column),
    ),
    totalCount: false,
    filtered: run.query.scope !== undefined,
  });
  return resultsPage(run, projection, page.rows, page.nextCursor);
}

/** The page of the rows a strategy's `ids` ranked. */
export async function idsPage(
  run: SearchRun,
  ids: NonNullable<AnyStrategy["ids"]>,
): Promise<SearchPage<unknown>> {
  if (run.query.cursor !== undefined) {
    throw unreadable("cursor is not a cursor of this search, which answers in one page", [
      "cursor",
    ]);
  }
  const scope = await scopeWhere(run);
  if (scope === "none") {
    return emptyPage();
  }
  const ranked = rankedIds(run, await ids(run.query.q, run.ctx, { limit: run.query.limit }));
  stopIfAborted(run);
  if (ranked.length === 0) {
    return emptyPage();
  }
  const projection = projectionOf(run.call, run.context.projection);
  const rows = await run.call.table.findMany({
    where: allOf([{ id: { in: ranked } }, scope]),
    select: projection.select,
  });
  const found = new Map(rows.map((row) => [row.id, row]));
  const present = ranked.filter((id) => found.has(id));
  const allowed = await allowedIds(run.call, run.context.form, present, run.level, "read");
  return resultsPage(
    run,
    projection,
    allowed.map((id) => found.get(id) as Row),
    null,
  );
}
