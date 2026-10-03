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

import type { AnyContract } from "../contract/defineContract";
import type { MethodKind, MethodOutput, Watch } from "../contract/methods";
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
 * Builds `{ [key]: { [method]: member(target) } }` from `contracts`, frozen.
 * `owner` names the function that builds it, in error messages; `reserved`
 * are keys the caller object uses itself, which no service may take.
 */
export function buildCaller(
  owner: string,
  contracts: ContractMap,
  member: (target: MethodTarget) => object,
  reserved: readonly string[] = [],
): Record<string, object> {
  if (typeof contracts !== "object" || contracts === null) {
    throw new TypeError(`${owner}: pass the contracts as an object, { task, project }`);
  }
  const services = Object.entries(contracts).map(([key, value]) => {
    const contract = checkEntry(owner, key, value, reserved);
    const methods = Object.entries(contract.methods).map(([method, definition]) => [
      method,
      member({
        service: contract.name,
        method,
        kind: definition.kind,
        output: definition.output,
        watch: definition.watch,
      }),
    ]);
    return [key, Object.freeze(Object.fromEntries(methods))];
  });
  return Object.fromEntries(services) as Record<string, object>;
}
