// What the search kit's handler works with (RFC 0003 section 12.2): what
// `search.handlers` made it from, and, per call, the call itself.

import type { AccessLevel } from "../../../contract/access";
import type { SearchSpec } from "../../../contract/kits/search";
import type { SearchQuery } from "../../../contract/kits/searchSchemas";
import type { Revision } from "../../../protocol/envelope";
import type { AccessForm } from "../../access/types";
import type { StorageWhere } from "../../storage";
import type { MaybePromise } from "../../types";
import type { CrudCall } from "../crud/runtime";
import type { SearchIdsOptions, SearchStrategyContext } from "./types";

/** A strategy as the handler calls it. */
export interface AnyStrategy {
  readonly where?: (q: string, ctx: SearchStrategyContext) => MaybePromise<StorageWhere>;
  readonly ids?: (
    q: string,
    ctx: SearchStrategyContext,
    options: SearchIdsOptions,
  ) => MaybePromise<readonly string[]>;
}

/** What one search method's handler is made from. */
export interface SearchContext {
  readonly spec: SearchSpec;
  readonly form: AccessForm;
  /** The projection the results are: `"entity"` or one of the contract's. */
  readonly projection: string;
  readonly strategy: AnyStrategy | undefined;
}

/** One search call. */
export interface SearchRun {
  readonly call: CrudCall;
  readonly context: SearchContext;
  readonly query: SearchQuery;
  /** The call's `ctx`, as the strategy receives it. */
  readonly ctx: SearchStrategyContext;
  /** The dispatcher's database client. */
  readonly db: unknown;
  /** The level the caller needs on each row found: the form's `entry` or `scope` level, else `Read`. */
  readonly level: AccessLevel;
  /** The revision taken before the call read anything: a scoped page's `rev`. */
  readonly rev: Revision;
}
