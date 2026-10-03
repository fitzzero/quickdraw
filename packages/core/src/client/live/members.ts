"use client";

// The live members of `qd.<service>` (RFC 0003 sections 11 and 11.5), built
// once per contract with the rest of the client (`../members.ts`):
// `useEntity` and `useEntities` for a contract with an entity, and one
// member per collection, `qd.<service>.<collection>.useCollection`. A
// collection's member lives beside the methods, not on the service, because
// methods and collections share one namespace.

import type { AnyContract } from "../../contract/defineContract";
import type { CollectionTarget } from "./collectionLoads";
import { useCollection, type UseCollectionOptions } from "./useCollection";
import { useEntities, useEntity, type UseEntityOptions } from "./useEntity";

/**
 * The live members of one contract's service, keyed as they sit on
 * `qd.<service>`. Built with `Object.fromEntries`, so a collection named
 * `__proto__` is an ordinary member, never a prototype.
 */
export function liveMembers(contract: AnyContract): Readonly<Record<string, object>> {
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
  return Object.freeze(Object.fromEntries([...entities, ...collections]));
}
