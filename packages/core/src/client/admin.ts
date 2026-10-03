"use client";

// The admin kit's client half (RFC 0003 sections 11 and 12.4). For a
// contract with the kit, `qd.<service>.admin` holds the members of its admin
// methods, `qd.task.admin.adminList.useQuery({ page })`, found by what the
// contract half marked them with, never by their names; they are the same
// members as `qd.<service>.<method>`, gathered for admin screens. A contract
// without the kit has no `admin` member (the name is reserved, so no method
// or collection takes it).
//
// `useAdminServices(qd)` lists the client's services an admin screen can
// show: those whose contract has the kit's `adminMeta` and whose `adminMeta`
// answers the user, with the display name it gives. One query per service,
// cached under the same key as `qd.<service>.admin.adminMeta.useQuery()`, so
// the screen that follows reads the cache. 4.1 apps listed the services the
// user's `serviceAccess` granted `Admin` on, and fetched each `adminMeta` one
// at a time through untyped hooks.

import { useMemo } from "react";
import type { AnyContract } from "../contract/defineContract";
import { adminSpecOf, type AdminServiceMeta } from "../contract/kits/admin";

/** One service's `adminMeta` query, as `useAdminServices` runs it. */
export interface AdminMetaQuery {
  /** The service's key on the client. */
  readonly key: string;
  /** The service's name on the wire. */
  readonly serviceName: string;
  /** The `adminMeta` method's name in the contract. */
  readonly method: string;
  /** Its member: a mock client answers from the member's stub. */
  readonly member: { call(): Promise<unknown> };
}

/** What one `adminMeta` query shows. */
export interface AdminMetaState {
  readonly data: AdminServiceMeta | undefined;
  readonly error: unknown;
}

/**
 * Runs the `adminMeta` queries of a client's services, one TanStack query
 * each, as the client's own query hooks run them (a mock client from its
 * stubs). A hook: the client that built the namespaces gives it.
 */
export type UseAdminMeta = (
  queries: readonly AdminMetaQuery[],
  enabled: boolean,
) => readonly AdminMetaState[];

/** What `useAdminServices` reads of one service's `admin` namespace. */
interface AdminNamespace {
  readonly serviceName: string;
  readonly meta: { readonly method: string; readonly member: AdminMetaQuery["member"] } | undefined;
  readonly useMeta: UseAdminMeta;
}

const NAMESPACES = new WeakMap<object, AdminNamespace>();

/**
 * The `admin` member of a contract's service on a client: the members of
 * the admin kit's methods, by their names in the contract; nothing for a
 * contract without the kit. `methods` are the service's method members;
 * `useMeta` is how the client runs `adminMeta` for `useAdminServices`.
 */
export function adminNamespace(
  contract: AnyContract,
  methods: Readonly<Record<string, object>>,
  useMeta: UseAdminMeta,
): Readonly<Record<string, object>> {
  const kit = Object.entries(contract.methods).flatMap(([name, definition]) => {
    const spec = adminSpecOf(definition);
    const member = Object.hasOwn(methods, name) ? methods[name] : undefined;
    return spec === undefined || member === undefined ? [] : [{ name, kind: spec.method, member }];
  });
  if (kit.length === 0) {
    return {};
  }
  const namespace = Object.freeze(
    Object.fromEntries(kit.map(({ name, member }) => [name, member])),
  );
  const meta = kit.find(({ kind }) => kind === "adminMeta");
  NAMESPACES.set(namespace, {
    serviceName: contract.name,
    meta:
      meta === undefined
        ? undefined
        : { method: meta.name, member: meta.member as AdminMetaQuery["member"] },
    useMeta,
  });
  return { admin: namespace };
}

/** The keys of a client's services that have the admin kit: those with an `admin` member. */
export type AdminKeysOf<Client> = {
  [Key in keyof Client & string]: Client[Key] extends { readonly admin: object } ? Key : never;
}[keyof Client & string];

/** One service `useAdminServices` lists. */
export interface AdminServiceInfo<Key extends string = string> {
  /** The service's key on the client: `qd[key].admin` holds its admin methods. */
  readonly key: Key;
  /** The service's name on the wire: `"taskService"`. */
  readonly serviceName: string;
  /** The service's name for people, as its `adminMeta` gives it: `"Tasks"`. */
  readonly displayName: string;
}

/** Options of `useAdminServices`. */
export interface UseAdminServicesOptions {
  /** `false` asks nothing and lists nothing. Default `true`. */
  readonly enabled?: boolean;
}

/** What `useAdminServices` returns. */
export interface UseAdminServicesResult<Key extends string = string> {
  /** The services whose `adminMeta` answered the user, in the client's order. */
  readonly services: readonly AdminServiceInfo<Key>[];
  /** True while some service's `adminMeta` has not answered. */
  readonly isLoading: boolean;
}

/** A client's `adminMeta` queries, and how the client runs them. */
interface AdminQueries {
  readonly queries: readonly AdminMetaQuery[];
  readonly useMeta: UseAdminMeta;
}

const NOTHING: readonly AdminMetaState[] = Object.freeze([]);

const NO_QUERIES: AdminQueries = Object.freeze({
  queries: Object.freeze([]),
  useMeta: () => NOTHING,
});

const QUERIES = new WeakMap<object, AdminQueries>();

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/** The `adminMeta` queries of the client's services with the kit: worked out once per client. */
function queriesOf(client: object): AdminQueries {
  const known = QUERIES.get(client);
  if (known !== undefined) {
    return known;
  }
  const found = Object.entries(client).flatMap(([key, service]) => {
    const admin: unknown = isObject(service) ? Reflect.get(service, "admin") : undefined;
    const namespace = isObject(admin) ? NAMESPACES.get(admin) : undefined;
    return namespace?.meta === undefined ? [] : [{ key, namespace, meta: namespace.meta }];
  });
  const [first] = found;
  const queries: AdminQueries =
    first === undefined
      ? NO_QUERIES
      : Object.freeze({
          queries: Object.freeze(
            found.map(({ key, namespace, meta }) =>
              Object.freeze({
                key,
                serviceName: namespace.serviceName,
                method: meta.method,
                member: meta.member,
              }),
            ),
          ),
          useMeta: first.namespace.useMeta,
        });
  QUERIES.set(client, queries);
  return queries;
}

const NONE: UseAdminServicesResult = Object.freeze({
  services: Object.freeze([]),
  isLoading: false,
});

function summarize(
  queries: readonly AdminMetaQuery[],
  states: readonly AdminMetaState[],
  enabled: boolean,
): UseAdminServicesResult {
  if (!enabled) {
    return NONE;
  }
  const services = queries.flatMap((query, index) => {
    const meta = states[index]?.data;
    return meta === undefined
      ? []
      : [{ key: query.key, serviceName: query.serviceName, displayName: meta.displayName }];
  });
  const isLoading = states.some((state) => state.data === undefined && state.error === null);
  return { services, isLoading };
}

/**
 * The services of `client` an admin screen can show: those whose contract
 * has the admin kit's `adminMeta`, once their `adminMeta` answers the user
 * (a service whose `adminMeta` refuses the user, `FORBIDDEN` or
 * `UNAUTHENTICATED`, is left out), with the display name it gives. Pass the
 * same client on every render.
 *
 * @example
 * const { services, isLoading } = useAdminServices(qd);
 * services.map(({ key, displayName }) => <Link href={`/admin/${key}`}>{displayName}</Link>);
 */
export function useAdminServices<Client extends object>(
  client: Client,
  options: UseAdminServicesOptions = {},
): UseAdminServicesResult<AdminKeysOf<Client>> {
  if (!isObject(client)) {
    throw new TypeError("useAdminServices: pass the client createQuickdrawClient made");
  }
  const enabled = options.enabled !== false;
  const { queries, useMeta } = queriesOf(client);
  const states = useMeta(queries, enabled);
  return useMemo(
    () => summarize(queries, states, enabled),
    [queries, states, enabled],
  ) as UseAdminServicesResult<AdminKeysOf<Client>>;
}
