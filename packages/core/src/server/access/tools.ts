// One engine call's policy evaluation: the `PolicyTools` a policy reads the
// database with, and the levels and filters of the bound policies. Every
// lookup goes through the call's memo, and the database reads through the
// cross-request cache when it is on (`cache.ts`): the service's rows, read
// once with every column its policy uses, and each membership table's levels
// per user.

import { isAccessLevel, type AccessLevel } from "../../contract/access";
import type { AnyContract } from "../../contract/defineContract";
import { QuickdrawError } from "../../protocol/errors";
import type { StorageAdapter, StorageRow } from "../storage";
import type { Principal } from "../types";
import type { Binding } from "./bindings";
import {
  createRequestMemo,
  lookup,
  namespace,
  type AccessCache,
  type LookupScope,
  type Namespace,
} from "./cache";
import { maxLevel } from "./levels";
import {
  idsOfFilter,
  type AccessFilter,
  type MembershipRead,
  type PolicyTools,
  type RowLevel,
  type RowLevels,
} from "./policy";

/** What every call of one dispatcher's engine shares. */
export interface EngineState {
  /** The bound policies, by service name. */
  readonly bindings: ReadonlyMap<string, Binding>;
  readonly storage: StorageAdapter | undefined;
  /** The cross-request cache, when `cacheMs` turned it on. */
  readonly cache: AccessCache | undefined;
}

/** One engine call: its lookups share a memo. */
export interface PolicyCall {
  /** The policy's level on each of `ids`: no service grants. */
  levels(binding: Binding, principal: Principal, ids: readonly string[]): Promise<RowLevels>;
  /** The policy's filter for `level`: no service grants. */
  where(binding: Binding, principal: Principal, level: AccessLevel): Promise<AccessFilter>;
  /**
   * The rows each of `ids`'s level is derived from, as `anchorKey`s: the row
   * itself, then its `inherit` parents up the chain. After `levels` in the
   * same call, the parents' ids come from the rows it already read.
   */
  anchors(binding: Binding, ids: readonly string[]): Promise<Map<string, string[]>>;
}

/** The key of the anchor `id` of `service`: a row a level is derived from. */
export function anchorKey(service: string, id: string): string {
  return `${service}\u0000${id}`;
}

/** What one call's tools share. */
interface CallScope {
  readonly state: EngineState;
  readonly storage: StorageAdapter;
  /** Memo, then cache: for reads with eviction rules. */
  readonly cached: LookupScope;
  /** Memo only: for everything else. */
  readonly memoOnly: LookupScope;
  readonly undeclared: Map<MembershipRead, Namespace>;
  readonly tools: Map<Binding, PolicyTools>;
  readonly call: PolicyCall;
}

function storageMissing(): never {
  throw new QuickdrawError(
    "INTERNAL",
    "An access policy read the database, but the dispatcher has no storage adapter: pass db as trackPrisma(prisma), or pass storage",
  );
}

/** Stands in for a storage adapter the dispatcher does not have: any use fails with `INTERNAL`. */
const NO_STORAGE = new Proxy(Object.freeze({}) as StorageAdapter, {
  get: (_target, key) => (key === "then" ? undefined : storageMissing()),
});

function roleLevel(read: MembershipRead, role: unknown): RowLevel {
  if (read.levels === undefined) {
    return isAccessLevel(role) ? role : null;
  }
  return typeof role === "string" && Object.hasOwn(read.levels, role)
    ? (read.levels[role] ?? null)
    : null;
}

async function readRows(
  storage: StorageAdapter,
  binding: Binding,
  ids: readonly string[],
): Promise<Map<string, StorageRow>> {
  const select = Object.fromEntries(["id", ...binding.columns].map((column) => [column, true]));
  const rows = await storage.findMany(binding.model, { where: { id: { in: [...ids] } }, select });
  const byId = new Map<string, StorageRow>();
  for (const row of rows) {
    if (typeof row.id === "string") {
      byId.set(row.id, row);
    }
  }
  return byId;
}

async function readMemberships(
  storage: StorageAdapter,
  read: MembershipRead,
  userId: string,
  ids: readonly string[],
): Promise<Map<string, RowLevel>> {
  const rows = await storage.findMany(read.model, {
    where: { [read.entry]: { in: [...ids] }, [read.user]: userId },
    select: { [read.entry]: true, [read.level]: true },
  });
  const levels = new Map<string, RowLevel>();
  for (const row of rows) {
    const entry = row[read.entry];
    if (typeof entry === "string") {
      levels.set(entry, maxLevel(levels.get(entry), roleLevel(read, row[read.level])));
    }
  }
  return levels;
}

function bindingOf(state: EngineState, contract: AnyContract): Binding {
  const binding = state.bindings.get(contract.name);
  if (binding === undefined) {
    throw new QuickdrawError(
      "INTERNAL",
      `An access policy asked about ${contract.name}, which this dispatcher serves without an access policy`,
    );
  }
  return binding;
}

/** Memo and cache for a membership table the policy declared; memo only for one it did not (a resolver's). */
function membershipScope(
  scope: CallScope,
  binding: Binding,
  read: MembershipRead,
): [LookupScope, Namespace] {
  const declared = binding.memberships.get(read);
  if (declared !== undefined) {
    return [scope.cached, declared];
  }
  let ns = scope.undeclared.get(read);
  if (ns === undefined) {
    ns = namespace(`${read.model} (undeclared)`);
    scope.undeclared.set(read, ns);
  }
  return [scope.memoOnly, ns];
}

async function idsWhere(
  scope: CallScope,
  contract: AnyContract,
  principal: Principal,
  level: AccessLevel,
): Promise<readonly string[]> {
  const target = bindingOf(scope.state, contract);
  const filter = await scope.call.where(target, principal, level);
  if (filter === "none") {
    return [];
  }
  const listed = idsOfFilter(filter);
  if (listed !== undefined) {
    return listed;
  }
  const rows = await scope.storage.findMany(target.model, { where: filter, select: { id: true } });
  return rows.map((row) => row.id).filter((id): id is string => typeof id === "string");
}

/** The tools `binding`'s policy gets in this call. */
function toolsFor(scope: CallScope, binding: Binding): PolicyTools {
  const made = scope.tools.get(binding);
  if (made !== undefined) {
    return made;
  }
  const { storage, state, call } = scope;
  const tools: PolicyTools = {
    storage,
    model: binding.model,
    rows: (ids) =>
      lookup(scope.cached, binding.rows, "", ids, (missing) => readRows(storage, binding, missing)),
    memberships(read, userId, ids) {
      const [where, ns] = membershipScope(scope, binding, read);
      return lookup(where, ns, userId, ids, (missing) =>
        readMemberships(storage, read, userId, missing),
      );
    },
    levelsOf: (contract, principal, ids) => call.levels(bindingOf(state, contract), principal, ids),
    whereOf: (contract, principal, level) =>
      call.where(bindingOf(state, contract), principal, level),
    idsWhere: (contract, principal, level) => idsWhere(scope, contract, principal, level),
  };
  scope.tools.set(binding, tools);
  return tools;
}

/** `PolicyCall.anchors`: each row, then the anchors of its `inherit` parents. */
async function anchorsOf(
  scope: CallScope,
  binding: Binding,
  ids: readonly string[],
): Promise<Map<string, string[]>> {
  const anchors = new Map(ids.map((id) => [id, [anchorKey(binding.service.name, id)]]));
  for (const link of binding.policy.reads.parents ?? []) {
    const rows = await toolsFor(scope, binding).rows(ids);
    const parentOf = new Map<string, string>();
    for (const id of ids) {
      const parent = rows.get(id)?.[link.via];
      if (typeof parent === "string" && parent.length > 0) {
        parentOf.set(id, parent);
      }
    }
    const parents = await anchorsOf(scope, bindingOf(scope.state, link.from), [
      ...new Set(parentOf.values()),
    ]);
    for (const [id, parent] of parentOf) {
      anchors.get(id)?.push(...(parents.get(parent) ?? []));
    }
  }
  return anchors;
}

/** Starts one engine call over `state`: its lookups share one memo. */
export function startCall(state: EngineState): PolicyCall {
  const memo = createRequestMemo();
  const memoOnly: LookupScope = { memo, cache: undefined, keepable: () => false };
  const scope: CallScope = {
    state,
    storage: state.storage ?? NO_STORAGE,
    cached: {
      memo,
      cache: state.cache,
      keepable: () => state.storage?.inTransaction?.() === false,
    },
    memoOnly,
    undeclared: new Map(),
    tools: new Map(),
    call: {
      levels: (binding, principal, ids) =>
        lookup(memoOnly, binding.levels, principal.userId, ids, (missing) =>
          binding.policy.levelsFor(principal, missing, toolsFor(scope, binding)),
        ),
      where: (binding, principal, level) =>
        binding.policy.accessWhere(principal, level, toolsFor(scope, binding)),
      anchors: (binding, ids) => anchorsOf(scope, binding, ids),
    },
  };
  return scope.call;
}
