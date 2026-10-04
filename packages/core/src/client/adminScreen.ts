"use client";

// A screen that serves every admin service from its metadata (RFC 0003
// section 12.4): the route names the service's key, `useAdminServices(qd)`
// lists them, and `adminMeta` names the fields at run time. Over a union of
// keys, `qd[key].admin` is a union of members typed per entity, whose sort
// fields and data cannot be given names read from `adminMeta`, so such a
// screen needed a cast (finding F3.7). `adminOf(qd, key)` gives one shape
// for every service instead: the same members, typed by field name.

import type { QueryClient, UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import type { SortDirection } from "../contract/collections";
import type { AdminMethodName, AdminServiceMeta } from "../contract/kits/admin";
import type { AdminPage, AdminSubscribers } from "../contract/kits/adminSchemas";
import type { FilterValue } from "../contract/kits/crudList";
import type { QuickdrawError } from "../protocol/errors";
import { adminNamespaceOf, type AdminKeysOf } from "./admin";
import type { MutationCallOptions, QueryCallOptions } from "./clientTypes";
import type { MethodMutationOptions, MethodQueryOptions } from "./hooks";
import type { MethodQueryKey } from "./keys";

/** A row as a metadata-driven admin screen handles it: its fields by name. */
export type AdminRow = Readonly<Record<string, unknown>> & { readonly id: string };

/** What a metadata-driven screen passes `adminList`: field names read from `adminMeta`. */
export interface AdminListRequest {
  /** The page, from 1. Default 1. */
  readonly page?: number;
  /** The rows per page: default 20, at most 100. */
  readonly pageSize?: number;
  /** Equality per field `adminMeta` marks `filterable`. */
  readonly filter?: Readonly<Record<string, FilterValue>>;
  /** One field `adminMeta` marks `sortable`; the kit's default order without it. */
  readonly sort?: { readonly field: string; readonly direction?: SortDirection };
}

/** The values an admin write sets, by field name. */
export type AdminWriteData = Readonly<Record<string, unknown>>;

/** A query member of an admin screen: the typed client's, typed by field name. */
export interface AdminQueryMember<Input, Output> {
  useQuery<Data = Output>(
    input: Input,
    options?: MethodQueryOptions<Output, Data, Input>,
  ): UseQueryResult<Data, QuickdrawError>;
  call(input: Input, options?: QueryCallOptions): Promise<Output>;
  key(input: Input): MethodQueryKey<Input>;
  prefetch(queryClient: QueryClient, input: Input): Promise<void>;
}

/** A mutation member of an admin screen: the typed client's, typed by field name. */
export interface AdminMutationMember<Input, Output> {
  useMutation<Context = unknown>(
    options?: MethodMutationOptions<Output, Input, Context>,
  ): UseMutationResult<Output, QuickdrawError, Input, Context>;
  call(input: Input, options?: MutationCallOptions): Promise<Output>;
}

/**
 * The admin kit's members of one service as a screen driven by `adminMeta`
 * calls them: rows and inputs by field name, the same for every service.
 * `adminMeta` and `adminList` are always there; a method the contract does
 * not expose (`admin.contract({ expose })`) is absent.
 */
export interface AdminScreen {
  readonly adminMeta: AdminQueryMember<undefined, AdminServiceMeta>;
  readonly adminList: AdminQueryMember<AdminListRequest | undefined, AdminPage<AdminRow>>;
  readonly adminGet?: AdminQueryMember<{ readonly id: string }, AdminRow>;
  readonly adminCreate?: AdminMutationMember<{ readonly data: AdminWriteData }, AdminRow>;
  readonly adminUpdate?: AdminMutationMember<
    { readonly id: string; readonly data: AdminWriteData },
    AdminRow
  >;
  readonly adminDelete?: AdminMutationMember<{ readonly id: string }, null>;
  readonly adminSubscribers?: AdminQueryMember<{ readonly id: string }, AdminSubscribers>;
  readonly adminReemit?: AdminMutationMember<{ readonly id: string }, AdminSubscribers>;
}

const SCREENS = new WeakMap<object, AdminScreen>();

/**
 * `client[key].admin` as one shape for every service: the same members,
 * keyed by what the kit made them for and typed by field name, for a screen
 * that reads the fields from `adminMeta` at run time. Throws a `TypeError`
 * for a key whose contract has no admin kit, or exposes no `adminMeta` or
 * `adminList`. The same object for the same service every time, so its
 * hooks can be called on every render.
 *
 * @example
 * const admin = adminOf(qd, key); // key: AdminKeysOf<typeof qd>, from the route
 * const { data: meta } = admin.adminMeta.useQuery(undefined);
 * const { data: page } = admin.adminList.useQuery({ page, sort: { field: "createdAt", direction: "desc" } });
 */
export function adminOf<Client extends object>(
  client: Client,
  key: AdminKeysOf<Client>,
): AdminScreen {
  const namespace = adminNamespaceOf(client, key);
  if (namespace === undefined) {
    throw new TypeError(`adminOf: "${key}" is not a service of this client with the admin kit`);
  }
  const known = SCREENS.get(namespace);
  if (known !== undefined) {
    return known;
  }
  const missing = (["adminMeta", "adminList"] as const).filter(
    (kind: AdminMethodName) => namespace.byKind[kind] === undefined,
  );
  if (missing.length > 0) {
    throw new TypeError(
      `adminOf: "${key}" exposes no ${missing.join(" or ")}, which an admin screen reads`,
    );
  }
  const screen = Object.freeze({ ...namespace.byKind }) as unknown as AdminScreen;
  SCREENS.set(namespace, screen);
  return screen;
}
