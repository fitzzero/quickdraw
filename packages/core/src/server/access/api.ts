// `dispatcher.access` (RFC 0003 sections 4.2 and 4.3): one policy, every
// surface. The levels and list filters a dispatcher's services' policies
// give, counted the way an `{ entry }` check counts them, for the framework's
// later surfaces (subscriptions, collections, kits) and for handlers that
// filter a list themselves; plus the access-change events revocation
// listens to.

import { isAccessLevel, type AccessLevel } from "../../contract/access";
import type { AnyContract } from "../../contract/defineContract";
import type { FlushSink } from "../uow/flushSink";
import type { Principal } from "../types";
import type { Binding } from "./bindings";
import type { AccessChangeListener, Forgotten } from "./changes";
import { serviceGrant } from "./levels";
import type { AccessFilter, RowLevels } from "./policy";
import { anchorKey, startCall, type EngineState } from "./tools";
import type { RowAccess } from "./types";

/** The dispatcher's view of its services' access policies: `dispatcher.access`. */
export interface DispatcherAccess {
  /**
   * The principal's level on each of `ids` of `service`, as an `{ entry }`
   * check counts it: the service's policy, or `Admin` on every row when the
   * principal holds a service-wide `Admin` grant and the service keeps
   * `adminBypass` on. A grant below `Admin` does not count. A row that is
   * not found has no level. One batched lookup per policy.
   */
  levelsFor(
    service: AnyContract | string,
    principal: Principal,
    ids: readonly string[],
  ): Promise<RowLevels>;
  /**
   * A filter for `db.<model>.findMany({ where })` matching exactly the rows of
   * `service` on which `levelsFor` gives the principal at least `level`:
   * `{}` (every row) for a service-wide `Admin` with `adminBypass`, or
   * `"none"` when no row matches.
   */
  accessWhere(
    service: AnyContract | string,
    principal: Principal,
    level: AccessLevel,
  ): Promise<AccessFilter>;
  /**
   * Calls `listener` after each flush whose tracked writes may have changed
   * someone's access to a row (`AccessChange`), once the cache no longer
   * holds what they changed. A promise it returns is awaited before the
   * dispatcher's other flush sinks run. Returns a function that removes it.
   */
  onAccessChanged(listener: AccessChangeListener): () => void;
}

/** A principal's levels on rows, and the rows each level is derived from. */
export interface ResolvedAccess {
  readonly levels: RowLevels;
  /**
   * Per id, the `anchorKey`s of the rows its level is derived from (RFC 0003
   * section 4.4): the row itself, then its `inherit` parents. A service-wide
   * `Admin` grant anchors on the row only.
   */
  readonly anchors: ReadonlyMap<string, readonly string[]>;
}

/** Options of {@link PolicyEngine.resolve}. */
export interface ResolveOptions {
  /**
   * Whether the principal's service-wide `Admin` grant on the service counts,
   * as it does for `levelsFor`. Default `true`. A collection scope asks its
   * anchor's policy with `false`, as a `{ scope, of }` form asks `of`'s: the
   * grants that count there are those on the collection's own service.
   */
  readonly grants?: boolean;
}

/** What a dispatcher's policy engine provides. */
export interface PolicyEngine extends DispatcherAccess {
  /** Decides `entry` and `scope` forms for the basic engine. */
  readonly rows: RowAccess;
  /** Evicts the cache and reports access changes: first on the sink list. `undefined` without policies. */
  readonly sink: FlushSink | undefined;
  /**
   * `levelsFor` and the anchors of each level, from one engine call: the
   * anchors reuse the rows the levels read. Live subscriptions record them.
   */
  resolve(
    service: string,
    principal: Principal,
    ids: readonly string[],
    options?: ResolveOptions,
  ): Promise<ResolvedAccess>;
  /**
   * Evicts from the cross-request cache what an access change this process
   * did not flush names (another node broadcast it), or a regranted user's
   * levels, so the re-resolution that follows reads afresh (`forgetAccess`).
   */
  forget(forgotten: Forgotten): void;
}

function bindingFor(state: EngineState, service: AnyContract | string): Binding {
  const name =
    typeof service === "string" ? service : (service as { readonly name?: unknown })?.name;
  const binding = typeof name === "string" ? state.bindings.get(name) : undefined;
  if (binding === undefined) {
    throw new TypeError(
      `dispatcher.access: ${String(name)} is not a service of this dispatcher with an access policy`,
    );
  }
  return binding;
}

function checkPrincipal(principal: unknown): Principal {
  const userId = (principal as { readonly userId?: unknown } | null | undefined)?.userId;
  if (typeof userId !== "string" || userId.length === 0) {
    throw new TypeError("dispatcher.access: principal must be a principal with a userId");
  }
  return principal as Principal;
}

/** True when the principal's service-wide `Admin` grant passes every check on the service. */
function bypasses(binding: Binding, principal: Principal): boolean {
  const { service } = binding;
  return service.adminBypass && serviceGrant(principal, service.name) === "Admin";
}

function checkIds(ids: unknown): readonly string[] {
  const valid = Array.isArray(ids) && ids.every((id) => typeof id === "string" && id !== "");
  if (!valid) {
    throw new TypeError("dispatcher.access.levelsFor: ids must be an array of row ids");
  }
  return ids as readonly string[];
}

/** The levels, filters and anchors of a dispatcher's policies. */
export function createAccessApi(
  state: EngineState,
): Pick<PolicyEngine, "levelsFor" | "accessWhere" | "resolve"> {
  return {
    async levelsFor(service, principal, ids) {
      const binding = bindingFor(state, service);
      const who = checkPrincipal(principal);
      checkIds(ids);
      if (bypasses(binding, who)) {
        return new Map(ids.map((id) => [id, "Admin"]));
      }
      return await startCall(state).levels(binding, who, ids);
    },
    async resolve(service, principal, ids, options) {
      const binding = bindingFor(state, service);
      const who = checkPrincipal(principal);
      checkIds(ids);
      if (options?.grants !== false && bypasses(binding, who)) {
        return {
          levels: new Map(ids.map((id) => [id, "Admin"])),
          anchors: new Map(ids.map((id) => [id, [anchorKey(binding.service.name, id)]])),
        };
      }
      const call = startCall(state);
      const levels = await call.levels(binding, who, ids);
      return { levels, anchors: await call.anchors(binding, ids) };
    },
    async accessWhere(service, principal, level) {
      const binding = bindingFor(state, service);
      const who = checkPrincipal(principal);
      if (!isAccessLevel(level)) {
        throw new TypeError("dispatcher.access.accessWhere: level must be an access level");
      }
      if (bypasses(binding, who)) {
        return {};
      }
      return await startCall(state).where(binding, who, level);
    },
  };
}
