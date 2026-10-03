// The search kit's handler (RFC 0003 section 12.2): a list with a text
// condition. A query shorter than the method's `minLength`, once trimmed,
// finds nothing and reads nothing. Otherwise the call takes the revision a
// scoped page carries before it reads anything, and reads its page with the
// strategy's `ids` (`idsPage`) or with a condition (`wherePage`).

import type { SearchPage, SearchQuery } from "../../../contract/kits/searchSchemas";
import { currentRev } from "../../rev";
import { rowLevel } from "../crud/access";
import { crudCall, type KitHandler, type KitHandlerArgs } from "../crud/runtime";
import type { SearchContext, SearchRun } from "./context";
import { idsPage, wherePage } from "./pages";
import { emptyPage } from "./results";
import type { SearchStrategyContext } from "./types";

/** The handler of one search method. */
export function searchHandler(context: SearchContext): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<SearchPage<unknown>> => {
    const query = input as SearchQuery;
    if (query.q.length < context.spec.minLength) {
      return emptyPage();
    }
    const run: SearchRun = {
      call: crudCall(ctx, db),
      context,
      query,
      ctx: ctx as SearchStrategyContext,
      db,
      level: rowLevel(context.form, "Read"),
      rev: currentRev(),
    };
    const ids = context.strategy?.ids;
    return ids === undefined ? await wherePage(run) : await idsPage(run, ids);
  };
  return handler as KitHandler;
}
