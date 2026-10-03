"use client";

// The live members of `qd.<service>` (RFC 0003 sections 11, 11.5, 12.2 and
// 12.5), built once per contract with the rest of the client
// (`../members.ts`): `useEntity` and `useEntities` for a contract with an
// entity, one member per collection,
// `qd.<service>.<collection>.useCollection`, and one per stream, channel and
// event (`realtimeMembers.ts`). A collection's member lives beside the
// methods, not on the service, because methods, collections, streams,
// channels and events share one namespace. For the same reason a search kit
// method's `useSearch` lives on that method's member,
// `qd.<service>.<search>.useSearch`. A contract with the admin kit also gets
// `qd.<service>.admin`, its admin methods' members together (`../admin.ts`).

import type { AnyContract } from "../../contract/defineContract";
import type { MethodDef } from "../../contract/methods";
import { clientAdminNamespace } from "../adminMeta";
import type { MethodTarget } from "../members";
import type { CollectionTarget } from "./collectionLoads";
import { realtimeMembers } from "./realtimeMembers";
import { searchTargetOf } from "./searchResults";
import { useCollection, type UseCollectionOptions } from "./useCollection";
import { useEntities, useEntity, type UseEntityOptions } from "./useEntity";
import { useSearch } from "./useSearch";

type UseSearchOptions = Parameters<typeof useSearch>[2];

/**
 * The live members of one contract's service, keyed as they sit on
 * `qd.<service>`, and its `admin` member when the contract has the admin
 * kit (`methods` are the service's method members). Built with
 * `Object.fromEntries`, so a collection named `__proto__` is an ordinary
 * member, never a prototype.
 */
export function liveMembers(
  contract: AnyContract,
  methods: Readonly<Record<string, object>> = {},
): Readonly<Record<string, object>> {
  const service = contract.name;
  const entities: [string, object][] =
    contract.entity === undefined
      ? []
      : [
          [
            "useEntity",
            (id: string | null | undefined, options?: UseEntityOptions) =>
              useEntity(service, id, options),
          ],
          [
            "useEntities",
            (ids: readonly string[], options?: UseEntityOptions) =>
              useEntities(service, ids, options),
          ],
        ];
  const collections = Object.entries(contract.collections).map(([collection, def]) => {
    const target: CollectionTarget = Object.freeze({ service, collection, def });
    const member = Object.freeze({
      useCollection: (scope: string | null | undefined, options?: UseCollectionOptions) =>
        useCollection(target, scope, options),
    });
    return [collection, member] as [string, object];
  });
  const admin = Object.entries(clientAdminNamespace(contract, methods));
  return Object.freeze(
    Object.fromEntries([...entities, ...collections, ...realtimeMembers(contract), ...admin]),
  );
}

/**
 * What a query member gets besides its own hooks: `useSearch` when the
 * search kit made its method (RFC 0003 section 12.2), found by what the
 * contract half marked it with, never by its name; nothing otherwise.
 */
export function searchMember(
  target: MethodTarget,
  definition: MethodDef,
  contract: AnyContract,
): Readonly<Record<string, unknown>> {
  const search = searchTargetOf(target, definition, contract);
  if (search === undefined) {
    return {};
  }
  return {
    useSearch: (q: string, options?: UseSearchOptions) => useSearch(search, q, options),
  };
}
