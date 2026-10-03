// What a client made by `createQuickdrawClient` uses outside React: the
// connection and the invalidation coordinator of the `QuickdrawProvider` it
// was given to (`bindConnection`), for its members' `call` and `prefetch`
// and for `qd.invalidate`; and which of its queries watch a change topic.
//
// React-free.

import type { QueryKey } from "@tanstack/react-query";
import { QuickdrawError } from "../protocol/errors";
import type { QuickdrawConnection } from "./connection";
import type { InvalidationCoordinator } from "./coordinator";
import { KEY_ROOT, methodKey, methodKeyPrefix } from "./keys";
import type { MethodTarget } from "./members";

/** The provider's connection and coordinator, while one is mounted, and the client's watching queries. */
export interface Binding {
  connection: QuickdrawConnection | null;
  coordinator: InvalidationCoordinator | null;
  /** `service\u0000method` of every query whose contract declares `watch`. */
  readonly watched: Set<string>;
}

const bindings = new WeakMap<object, Binding>();

/** The target of each query member, so `qd.invalidate` can take a member. */
const queryTargets = new WeakMap<object, MethodTarget>();

function watchedKey(service: unknown, method: unknown): string {
  return `${String(service)}\u0000${String(method)}`;
}

function needsProvider(user: string): QuickdrawError {
  return new QuickdrawError(
    "INTERNAL",
    `${user} needs a mounted <QuickdrawProvider> for this client`,
  );
}

/** A client's binding, unbound. */
export function createBinding(): Binding {
  return { connection: null, coordinator: null, watched: new Set() };
}

/** Records the client object a binding belongs to. */
export function attachBinding(client: object, binding: Binding): void {
  bindings.set(client, binding);
}

/** Records a query member of a client: `qd.invalidate` takes it, and its watch counts after a reconnect. */
export function registerQuery(binding: Binding, member: object, target: MethodTarget): void {
  queryTargets.set(member, target);
  if (target.watch !== undefined) {
    binding.watched.add(watchedKey(target.service, target.method));
  }
}

/** The bound connection, for `member` of `target`; `INTERNAL` while no provider is mounted. */
export function connectionOf(
  binding: Binding,
  target: MethodTarget,
  member: string,
): QuickdrawConnection {
  if (binding.connection === null) {
    throw needsProvider(`${target.service}.${target.method}.${member}`);
  }
  return binding.connection;
}

/**
 * `qd.invalidate(member, input?)` or `qd.invalidate(queryKey)`, through the
 * bound coordinator: a member with `input` invalidates that one result, a
 * member alone every result of the query, a key what it prefixes.
 */
export function invalidateWith(binding: Binding): (target: unknown, ...input: unknown[]) => void {
  return (target, ...input) => {
    const { coordinator } = binding;
    if (coordinator === null) {
      throw needsProvider("qd.invalidate");
    }
    const query =
      typeof target === "object" && target !== null ? queryTargets.get(target) : undefined;
    if (query !== undefined) {
      if (input[0] === undefined) {
        coordinator.invalidate(methodKeyPrefix(query.service, query.method));
      } else {
        coordinator.invalidate(methodKey(query.service, query.method, input[0]), { exact: true });
      }
    } else if (Array.isArray(target)) {
      coordinator.invalidate(target as QueryKey);
    } else {
      throw new TypeError(
        "qd.invalidate: pass a query member, such as qd.task.get, or a query key",
      );
    }
  };
}

/**
 * Makes `connection`, and `coordinator` when given, the ones `client`'s
 * `call`, `prefetch` and `invalidate` use, until the returned function runs
 * (unless another connection was bound meanwhile). `QuickdrawProvider` binds
 * its own while it is mounted.
 */
export function bindConnection(
  client: object,
  connection: QuickdrawConnection,
  coordinator?: InvalidationCoordinator,
): () => void {
  const binding = bindings.get(client);
  if (binding === undefined) {
    throw new TypeError("QuickdrawProvider: client must be made by createQuickdrawClient");
  }
  binding.connection = connection;
  binding.coordinator = coordinator ?? null;
  return () => {
    if (binding.connection === connection) {
      binding.connection = null;
      binding.coordinator = null;
    }
  };
}

/**
 * Whether a cached query of `client` watches a change topic: its method's
 * contract declares `watch`. Such a query missed every `qd:changed` while
 * the connection was down, so it is refetched after a reconnect even when it
 * is fresh.
 */
export function isWatchedQuery(client: object, queryKey: QueryKey): boolean {
  const binding = bindings.get(client);
  const [root, service, kind, method] = queryKey;
  return (
    binding !== undefined &&
    root === KEY_ROOT &&
    kind === "m" &&
    binding.watched.has(watchedKey(service, method))
  );
}
