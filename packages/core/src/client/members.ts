// Builds a caller object from a map of contracts at runtime, with no code
// generation: `client[key][method]` for every contract in the map and every
// method of its contract. The typed client (`createClient.ts`) and the HTTP
// server caller (`serverCaller.ts`) are both built here.
//
// Every member object is made once, when the caller is created, and frozen,
// so a member's functions (hooks among them) are the same on every render;
// the caller freezes the object of services once it has added its own keys.
// No member is named `then`, so `await` never takes a caller or a service
// for a promise: contracts reserve `then` and `$`-names for their methods
// (`contract/validateContract.ts`), and the map's keys are checked here.
// Building from own enumerable entries into fresh objects means a key such
// as `__proto__` becomes an ordinary member, never a prototype.
//
// React-free.

import type { CollectionDef } from "../contract/collections";
import type { AnyContract } from "../contract/defineContract";
import type { MethodDef, MethodKind, MethodOutput, Watch } from "../contract/methods";
import type { ContractMap } from "../contract/infer";

/** One method of one service, as a member is built for it. */
export interface MethodTarget {
  /** The service's name on the wire: the contract's `name`. */
  readonly service: string;
  readonly method: string;
  readonly kind: MethodKind;
  /** The contract's `output`: a schema, or a projection reference such as `"entity"` or `listOf("card")`. */
  readonly output?: MethodOutput;
  /** The query's `watch` declaration, when it has one. */
  readonly watch?: Watch<string> | undefined;
  /** The collections of the method's contract, for a mutation's `addEntity`. */
  readonly collections?: Readonly<Record<string, CollectionDef>>;
}

function isContract(value: unknown): value is AnyContract {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { name, methods } = value as { readonly name?: unknown; readonly methods?: unknown };
  return typeof name === "string" && typeof methods === "object" && methods !== null;
}

function checkEntry(
  owner: string,
  key: string,
  contract: unknown,
  reserved: readonly string[],
): AnyContract {
  if (key === "then" || key.startsWith("$")) {
    throw new TypeError(
      `${owner}: "${key}" cannot name a service; "then" and $-names are reserved`,
    );
  }
  if (reserved.includes(key)) {
    throw new TypeError(`${owner}: "${key}" cannot name a service; the client uses it`);
  }
  if (!isContract(contract)) {
    throw new TypeError(`${owner}: "${key}" is not a contract from defineContract`);
  }
  return contract;
}

/**
 * Builds `{ [key]: { [method]: member(target, definition, contract) } }`
 * from `contracts`, frozen. `member` gets the method's declaration and its
 * contract too, for what a kit made (the search kit's `useSearch`). `owner`
 * names the function that builds it, in error messages; `reserved` are keys
 * the caller object uses itself, which no service may take. `live`, when
 * given, adds members of its own to each service (the typed client's
 * `useEntity`, `useEntities` and one member per collection); a contract
 * keeps them apart from its methods, since methods, collections and the
 * reserved names share one namespace. It gets the service's method members
 * too, for members that group them (the admin kit's `admin`).
 */
export function buildCaller(
  owner: string,
  contracts: ContractMap,
  member: (target: MethodTarget, definition: MethodDef, contract: AnyContract) => object,
  reserved: readonly string[] = [],
  live?: (
    contract: AnyContract,
    methods: Readonly<Record<string, object>>,
  ) => Readonly<Record<string, object>>,
): Record<string, object> {
  if (typeof contracts !== "object" || contracts === null) {
    throw new TypeError(`${owner}: pass the contracts as an object, { task, project }`);
  }
  const services = Object.entries(contracts).map(([key, value]) => {
    const contract = checkEntry(owner, key, value, reserved);
    const methods = Object.entries(contract.methods).map(([method, definition]) => [
      method,
      member(
        {
          service: contract.name,
          method,
          kind: definition.kind,
          output: definition.output,
          watch: definition.watch,
          collections: contract.collections,
        },
        definition,
        contract,
      ),
    ]);
    const extra = Object.entries(live?.(contract, Object.fromEntries(methods)) ?? {});
    return [key, Object.freeze(Object.fromEntries([...methods, ...extra]))];
  });
  return Object.fromEntries(services) as Record<string, object>;
}
