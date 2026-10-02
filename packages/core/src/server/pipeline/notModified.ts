// The "not modified" seam (RFC 0003 section 9, step 5). Before a query runs,
// the dispatcher asks for the current version of its result. When the caller
// sent that same version as `v`, the call answers `{ ok: true, nm: true, v }`
// without running the handler; otherwise the reply carries the version so the
// caller can send it next time.
//
// A query that declares `version(input, ctx)` answers for itself. For every
// other query the dispatcher asks its `versions` option, which the entity
// subscriptions card implements for queries whose output is one projection
// row (from the service's `versionColumn` or the in-process change log).

import type { Version } from "../../protocol/envelope";
import type { AnyContext } from "../context";
import type { AnyService, ServiceMethod } from "../service";
import type { MaybePromise } from "../types";

/** The query a version is asked for. */
export interface VersionRequest {
  readonly service: AnyService;
  readonly method: ServiceMethod;
  /** The input after its schema ran. */
  readonly input: unknown;
  /** The call's context; the caller has already been authorized. */
  readonly ctx: AnyContext;
}

/**
 * Answers the current version of a query's result, or `undefined` when it
 * does not know one (the query then always runs). Called after access was
 * checked, for queries that declare no `version` of their own. It must take
 * the version before any row is read, so a reply is never older than the
 * version it claims.
 */
export interface VersionSource {
  versionOf(request: VersionRequest): MaybePromise<Version | undefined>;
}

/** True when `value` can be a call's version: a finite number or a string. */
export function isVersion(value: unknown): value is Version {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}
