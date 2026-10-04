// Binding the services' access policies to a dispatcher (RFC 0003 section
// 4.2). A policy is plain data until a dispatcher serves its service: then
// it gets the service's model, the storage adapter it reads through, and the
// cache namespaces its lookups are kept in. Binding also checks, once, what
// would otherwise fail on the first call:
//
// - every `inherit({ from })` and every `{ scope, of }` names a service this
//   dispatcher serves, and that service declares a policy;
// - no chain of `inherit` comes back to where it started;
// - a policy that reads the database has a storage adapter to read through;
//
// and registers the columns policies read with the storage adapter
// (`registerInterest`), so tracked writes carry their `before` and `after`.

import type { AnyContract } from "../../contract/defineContract";
import type { Registry } from "../registry";
import type { AnyService } from "../service";
import { modelKey, type StorageAdapter } from "../storage";
import { isCustomAccess } from "./forms";
import { namespace, type Namespace } from "./cache";
import type { AnyAccessPolicy, MembershipRead } from "./policy";

/** A served service's policy, ready to evaluate. */
export interface Binding {
  readonly service: AnyService;
  /** The service's model, named as the client names it. */
  readonly model: string;
  readonly policy: AnyAccessPolicy;
  /** The columns of the model the policy reads; one query reads them all. */
  readonly columns: readonly string[];
  /** Where the rows' columns are memoized and cached. */
  readonly rows: Namespace;
  /** Where the policy's levels are memoized for one call. */
  readonly levels: Namespace;
  /** Where each membership table's levels are memoized and cached. */
  readonly memberships: ReadonlyMap<MembershipRead, Namespace>;
}

function fail(message: string): never {
  throw new TypeError(`createDispatcher: ${message}`);
}

function bind(service: AnyService, policy: AnyAccessPolicy, model: string): Binding {
  const { reads } = policy;
  return Object.freeze({
    service,
    model: modelKey(model),
    policy,
    columns: Object.freeze([...new Set(reads.columns)].filter((column) => column !== "id")),
    rows: namespace(`${service.name} rows`),
    levels: namespace(`${service.name} levels`),
    memberships: new Map(
      reads.memberships.map((read) => [read, namespace(`${service.name} ${read.model}`)]),
    ),
  });
}

/** The served service with a policy that `contract` names, or a `TypeError` saying why there is none. */
function target(
  bindings: ReadonlyMap<string, Binding>,
  registry: Registry,
  contract: AnyContract,
  what: string,
): Binding {
  const binding = bindings.get(contract.name);
  if (binding !== undefined) {
    return binding;
  }
  return registry.services.has(contract.name)
    ? fail(`${what} ${contract.name}, which declares no access policy`)
    : fail(`${what} ${contract.name}, which this dispatcher does not serve`);
}

/** Refuses an `inherit` chain that comes back to a service already on it. */
function checkCycles(bindings: ReadonlyMap<string, Binding>, registry: Registry): void {
  const visit = (binding: Binding, path: readonly string[]): void => {
    for (const parent of binding.policy.reads.inherits) {
      const next = target(
        bindings,
        registry,
        parent,
        `${binding.service.name}'s access policy inherits from`,
      );
      if (path.includes(next.service.name)) {
        fail(
          `the access policies of ${[...path, next.service.name].join(" -> ")} inherit in a cycle`,
        );
      }
      visit(next, [...path, next.service.name]);
    }
  };
  for (const binding of bindings.values()) {
    visit(binding, [binding.service.name]);
  }
}

/** Every `{ scope, of }` form must name a served service with a policy. */
function checkScopeForms(bindings: ReadonlyMap<string, Binding>, registry: Registry): void {
  for (const service of registry.services.values()) {
    for (const method of Object.values(service.methods)) {
      const form = method.access;
      if (typeof form === "object" && !isCustomAccess(form) && form.scope !== undefined) {
        target(bindings, registry, form.of, `${service.name}.${method.name} uses scope access of`);
      }
    }
  }
}

function registerInterest(bindings: ReadonlyMap<string, Binding>, storage: StorageAdapter): void {
  for (const binding of bindings.values()) {
    if (binding.columns.length > 0) {
      storage.registerInterest(binding.model, binding.columns);
    }
    for (const read of binding.memberships.keys()) {
      storage.registerInterest(read.model, [read.entry, read.user, read.level]);
    }
  }
}

/**
 * Binds the policies of the services in `registry`, by service name. Throws
 * a `TypeError` for a policy the dispatcher could not evaluate.
 */
export function bindPolicies(
  registry: Registry,
  storage: StorageAdapter | undefined,
): ReadonlyMap<string, Binding> {
  const bindings = new Map<string, Binding>();
  for (const service of registry.services.values()) {
    const { access, model } = service;
    if (access === undefined || model === undefined) {
      continue;
    }
    if (access.reads.storage && storage === undefined) {
      fail(
        `${service.name}'s access policy reads the database, so the dispatcher needs a storage adapter: pass db as trackPrisma(prisma), or pass storage`,
      );
    }
    bindings.set(service.name, bind(service, access, model));
  }
  checkCycles(bindings, registry);
  checkScopeForms(bindings, registry);
  if (storage !== undefined) {
    registerInterest(bindings, storage);
  }
  return bindings;
}
