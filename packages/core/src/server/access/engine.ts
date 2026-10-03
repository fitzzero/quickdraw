// The policy engine (RFC 0003 section 4): one per dispatcher, over the
// access policies its services declare. The dispatcher's default access
// engine is the basic engine with this one's row access, so every form is
// decided in one place:
//
// | Form                         | No principal      | Passes when                                      |
// |------------------------------|-------------------|--------------------------------------------------|
// | `"public"`                   | passes            | always                                           |
// | `"authenticated"`            | `UNAUTHENTICATED` | a principal exists                               |
// | `{ service: L }`             | `UNAUTHENTICATED` | the service grant is at least `L`                |
// | `{ entry: L, id? }`          | `UNAUTHENTICATED` | the policy's level on every row is at least `L`  |
// | `{ service: L1, entry: L2 }` | `UNAUTHENTICATED` | either of the two                                |
// | `{ scope: L, of, id }`       | `UNAUTHENTICATED` | `of`'s policy gives at least `L` on the row      |
// | `custom(fn)`                 | `UNAUTHENTICATED` | `fn(ctx, input)` resolves `true`                 |
//
// A service-wide `Admin` grant on the method's service passes every form but
// `"public"` when the service keeps `adminBypass` on; a grant below `Admin`
// counts only where the form names `service`. A principal that fails gets
// `FORBIDDEN`. Everything fails closed: a missing grant, an unknown level, a
// missing id, a row that is not found and a malformed access column deny,
// and a lookup that throws fails the call with `INTERNAL`. 4.1 let any
// signed-in user call a `Read` method with no row id, and let a service
// grant satisfy row checks at the same level
// (`legacy-src/server/BaseService.ts:581-600`); neither survives.

import type { Logger } from "../../contract/logger";
import type { Registry } from "../registry";
import type { StorageAdapter } from "../storage";
import { createAccessApi, type PolicyEngine } from "./api";
import { bindPolicies } from "./bindings";
import { createAccessCache } from "./cache";
import { createChangeSink, type AccessChangeListener } from "./changes";
import { createRowAccess } from "./rowAccess";

/** The access options of a dispatcher: its `access` option, when it is not an engine. */
export interface AccessOptions {
  /**
   * Keep the database reads of access policies (row columns and membership
   * levels) across requests for this long, in milliseconds. Tracked writes to
   * the columns and models the policies read evict what they change; writes
   * the tracked client cannot see (raw SQL without `ctx.touch`, database
   * cascades, other processes) are seen only once the time passes. Default:
   * off, every request reads afresh (lookups are always memoized within one).
   */
  readonly cacheMs?: number;
}

/** Options of {@link createPolicyEngine}. */
export interface PolicyEngineOptions extends AccessOptions {
  readonly registry: Registry;
  readonly storage: StorageAdapter | undefined;
  readonly logger: Logger;
}

function checkCacheMs(cacheMs: unknown): number | undefined {
  if (cacheMs === undefined || cacheMs === 0) {
    return undefined;
  }
  if (typeof cacheMs !== "number" || !Number.isFinite(cacheMs) || cacheMs < 0) {
    throw new TypeError("createDispatcher: access.cacheMs must be a number of milliseconds");
  }
  return cacheMs;
}

/**
 * Binds the services' access policies (`bindings.ts`; throws a `TypeError`
 * for one that could not be evaluated) and returns the engine that
 * evaluates them.
 */
export function createPolicyEngine(options: PolicyEngineOptions): PolicyEngine {
  const cacheMs = checkCacheMs(options.cacheMs);
  const bindings = bindPolicies(options.registry, options.storage);
  const state = {
    bindings,
    storage: options.storage,
    cache: cacheMs === undefined ? undefined : createAccessCache({ ttlMs: cacheMs }),
  };
  const listeners = new Set<AccessChangeListener>();
  return Object.freeze({
    ...createAccessApi(state),
    onAccessChanged(listener: AccessChangeListener): () => void {
      if (typeof listener !== "function") {
        throw new TypeError("dispatcher.access.onAccessChanged: listener must be a function");
      }
      // A listener added twice is called twice and removed one at a time.
      const entry: AccessChangeListener = (change) => listener(change);
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    rows: createRowAccess(state),
    sink: createChangeSink(bindings, state.cache, listeners, options.logger),
  });
}
