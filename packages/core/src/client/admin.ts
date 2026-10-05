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
// the screen that follows reads the cache. It asks only the services the
// user's grants allow (the server's hello names them): `Admin`, what the
// kit's methods require unless the service says otherwise (`requires`
// changes it), so a user who administers nothing sends nothing (finding
// F3.6). 4.1 apps listed the services the user's `serviceAccess` granted
// `Admin` on, and fetched each `adminMeta` one at a time through untyped
// hooks.

import { useMemo } from "react";
import { ACCESS_LEVELS, type AccessLevel } from "../contract/access";
import type { AnyContract } from "../contract/defineContract";
import { adminSpecOf, type AdminMethodName, type AdminServiceMeta } from "../contract/kits/admin";

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

/** The user's service-wide grants, from the hello on the current credentials; `null` before it. A hook. */
export type UseAdminGrants = () => Readonly<Record<string, AccessLevel>> | null;

/** How a client runs its admin namespaces' hooks: the real client's, or a mock's. */
export interface AdminHooks {
  readonly useMeta: UseAdminMeta;
  readonly useGrants: UseAdminGrants;
}

/** What `useAdminServices` and `adminOf` read of one service's `admin` namespace. */
export interface AdminNamespace extends AdminHooks {
  readonly serviceName: string;
  readonly meta: { readonly method: string; readonly member: AdminMetaQuery["member"] } | undefined;
  /** The namespace's members by what the kit made them for, whatever the contract named them. */
  readonly byKind: Readonly<Partial<Record<AdminMethodName, object>>>;
}

const NAMESPACES = new WeakMap<object, AdminNamespace>();

/**
 * The `admin` member of a contract's service on a client: the members of
 * the admin kit's methods, by their names in the contract; nothing for a
 * contract without the kit. `methods` are the service's method members;
 * `hooks` are how the client runs `adminMeta` and reads the user's grants
 * for `useAdminServices`.
 */
export function adminNamespace(
  contract: AnyContract,
  methods: Readonly<Record<string, object>>,
  hooks: AdminHooks,
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
    byKind: Object.freeze(Object.fromEntries(kit.map(({ kind, member }) => [kind, member]))),
    useMeta: hooks.useMeta,
    useGrants: hooks.useGrants,
  });
  return { admin: namespace };
}

/** The registered namespace of `client[key].admin`, or `undefined`. */
export function adminNamespaceOf(client: object, key: string): AdminNamespace | undefined {
  const service: unknown = Object.hasOwn(client, key) ? Reflect.get(client, key) : undefined;
  const admin: unknown = isObject(service) ? Reflect.get(service, "admin") : undefined;
  return isObject(admin) ? NAMESPACES.get(admin) : undefined;
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
  /**
   * The service-wide grant a service's `adminMeta` needs, as the server's
   * hello names the user's grants: a service whose grant is below it is
   * left out without a call. Default `"Admin"`, what the admin kit's
   * methods require unless `admin.handlers(contract, { access })` gives
   * another; `null` asks every service (an `adminMeta` open to others).
   */
  readonly requires?: AccessLevel | null;
}

/** What `useAdminServices` returns. */
export interface UseAdminServicesResult<Key extends string = string> {
  /** The services whose `adminMeta` answered the user, in the client's order. */
  readonly services: readonly AdminServiceInfo<Key>[];
  /** True while some service's `adminMeta` has not answered. */
  readonly isLoading: boolean;
}

/** A client's `adminMeta` queries, and how the client runs them. */
interface AdminQueries extends AdminHooks {
  readonly queries: readonly AdminMetaQuery[];
}

const NOTHING: readonly AdminMetaState[] = Object.freeze([]);

const NO_GRANTS: Readonly<Record<string, AccessLevel>> = Object.freeze({});

const NO_QUERIES: AdminQueries = Object.freeze({
  queries: Object.freeze([]),
  useMeta: () => NOTHING,
  useGrants: () => NO_GRANTS,
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
          useGrants: first.namespace.useGrants,
        });
  QUERIES.set(client, queries);
  return queries;
}

const NONE: UseAdminServicesResult = Object.freeze({
  services: Object.freeze([]),
  isLoading: false,
});

const LOADING: UseAdminServicesResult = Object.freeze({
  services: Object.freeze([]),
  isLoading: true,
});

/** True when `level` is at least `required`; no grant meets nothing. */
function meets(level: AccessLevel | undefined, required: AccessLevel): boolean {
  return level !== undefined && ACCESS_LEVELS.indexOf(level) >= ACCESS_LEVELS.indexOf(required);
}

/** The queries the user's grants allow: none before the hello, every one without a requirement. */
function allowed(
  queries: readonly AdminMetaQuery[],
  grants: Readonly<Record<string, AccessLevel>> | null,
  requires: AccessLevel | null,
): readonly AdminMetaQuery[] {
  if (grants === null) {
    return NOTHING_ASKED;
  }
  return requires === null
    ? queries
    : queries.filter((query) =>
        meets(
          Object.hasOwn(grants, query.serviceName) ? grants[query.serviceName] : undefined,
          requires,
        ),
      );
}

const NOTHING_ASKED: readonly AdminMetaQuery[] = Object.freeze([]);

function summarize(
  queries: readonly AdminMetaQuery[],
  states: readonly AdminMetaState[],
  enabled: boolean,
  known: boolean,
): UseAdminServicesResult {
  if (!enabled) {
    return NONE;
  }
  if (!known) {
    return LOADING;
  }
  const services = queries.flatMap((query, index) => {
    const meta = states[index]?.data;
    return meta === undefined
      ? []
      : [{ key: query.key, serviceName: query.serviceName, displayName: meta.displayName }];
  });
  // A query without a state yet (the render that adds it) has not answered either.
  const isLoading = queries.some((_query, index) => {
    const state = states[index];
    return state === undefined || (state.data === undefined && state.error === null);
  });
  return { services, isLoading };
}

/**
 * The services of `client` an admin screen can show: those whose contract
 * has the admin kit's `adminMeta`, once their `adminMeta` answers the user
 * (a service whose `adminMeta` refuses the user, `FORBIDDEN` or
 * `UNAUTHENTICATED`, is left out), with the display name it gives. It asks
 * only the services the user's grants allow (`requires`, `Admin` by
 * default), once the server's hello named them, and asks a refused one
 * again only when the user's grant on it changes. Pass the same client on
 * every render.
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
  const requires = options.requires === undefined ? "Admin" : options.requires;
  const { queries, useMeta, useGrants } = queriesOf(client);
  const grants = useGrants();
  const asked = useMemo(() => allowed(queries, grants, requires), [queries, grants, requires]);
  const states = useMeta(asked, enabled && grants !== null);
  return useMemo(
    () => summarize(asked, states, enabled, grants !== null),
    [asked, states, enabled, grants],
  ) as UseAdminServicesResult<AdminKeysOf<Client>>;
}
