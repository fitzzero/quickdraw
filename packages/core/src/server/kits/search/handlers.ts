// `search.handlers(contract, { access, strategy?, method? })` (RFC 0003
// section 12.2): the search kit's server half. It finds the methods
// `search.contract` made in the contract (usually one, `search`) and returns
// their implementation, to spread into `defineService`'s `methods`; `method`
// picks one, for a contract with several that need different access forms
// or strategies:
//
//   export const taskService = qd.defineService(task, {
//     model: "task",
//     access: inherit({ from: project, via: "projectId" }),
//     methods: {
//       ...search.handlers(task, { access: "authenticated" }),
//     },
//   });
//
// The method shares identical concurrent calls by one caller
// (`share: "caller"`): a client typing sends the same search from several
// places at once. The handler finds its service through the call
// (`kitRuntimeOf`), so the service must declare its `model`; `defineService`
// checks that when the service is defined. A search kept to a scope returns
// the scope collection's items, so its item must be that collection's item
// projection: checked here, when the contract is known.

import type { AnyContract } from "../../../contract/defineContract";
import {
  search as contractHalf,
  searchSpecOf,
  type SearchSpec,
} from "../../../contract/kits/search";
import { accessFormProblem } from "../../access/forms";
import type { AccessForm } from "../../access/types";
import { checkWhenDefined, type AnyService } from "../../service";
import type { AnyStrategy } from "./context";
import { searchHandler } from "./run";
import type {
  SearchAccess,
  SearchContract,
  SearchHandlersOptions,
  SearchImplementations,
  SearchMethodsOf,
} from "./types";

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new TypeError(`search.handlers: ${message}`);
}

/** The search kit's methods in the contract, with what each was made for; at least one. */
function kitMethods(contract: unknown): [string, SearchSpec][] {
  const valid =
    isRecord(contract) &&
    typeof contract.name === "string" &&
    isRecord(contract.methods) &&
    Object.isFrozen(contract);
  if (!valid) {
    fail("the first argument must be a contract from defineContract");
  }
  const found: [string, SearchSpec][] = [];
  for (const [name, def] of Object.entries(contract.methods as UnknownRecord)) {
    const spec = searchSpecOf(def);
    if (spec !== undefined) {
      found.push([name, spec]);
    }
  }
  if (found.length === 0) {
    fail(`${String(contract.name)} has no method search.contract made`);
  }
  return found;
}

/** `strategy`: `{ where }` or `{ ids }`, a function either way. */
function checkStrategy(strategy: unknown): AnyStrategy | undefined {
  if (strategy === undefined) {
    return undefined;
  }
  const valid =
    isRecord(strategy) &&
    Object.keys(strategy).every((key) => key === "where" || key === "ids") &&
    (strategy.where === undefined) !== (strategy.ids === undefined) &&
    [strategy.where, strategy.ids].every(
      (hook) => hook === undefined || typeof hook === "function",
    );
  if (!valid) {
    fail("strategy must be { where: (q, ctx) => filter } or { ids: (q, ctx, { limit }) => ids }");
  }
  return strategy as AnyStrategy;
}

const OPTION_KEYS: readonly string[] = ["access", "strategy", "method"];

/** The options, checked: the access form, the strategy, and the methods to implement among `kit`. */
function checkOptions(
  options: unknown,
  kit: readonly [string, SearchSpec][],
): {
  readonly form: AccessForm;
  readonly strategy: AnyStrategy | undefined;
  readonly methods: readonly [string, SearchSpec][];
} {
  if (!isRecord(options)) {
    fail("options must be { access, strategy?, method? }");
  }
  const unknownKey = Object.keys(options).find((key) => !OPTION_KEYS.includes(key));
  if (unknownKey !== undefined) {
    fail(`options has an unknown key "${unknownKey}"; the options are ${OPTION_KEYS.join(", ")}`);
  }
  const problem = accessFormProblem(options.access);
  if (problem !== undefined) {
    fail(`access ${problem}`);
  }
  const { method } = options;
  const methods = method === undefined ? kit : kit.filter(([name]) => name === method);
  if (methods.length === 0) {
    fail(`method "${String(method)}" is not a method search.contract made`);
  }
  return {
    form: options.access as AccessForm,
    strategy: checkStrategy(options.strategy),
    methods,
  };
}

/** The projection a search's results are: the one whose schema `item` is, `"entity"` by default. */
function itemProjection(contract: AnyContract, name: string, spec: SearchSpec): string {
  if (contract.entity === undefined) {
    fail(`${contract.name} has no entity for ${name} to search`);
  }
  const { item } = spec;
  if (item === undefined || item === contract.entity) {
    return "entity";
  }
  const found = Object.entries(contract.projections).find(([, schema]) => schema === item);
  if (found === undefined) {
    fail(
      `the item of ${contract.name}.${name} must be its entity schema or one of its projections' schemas`,
    );
  }
  return found[0];
}

/** A scope collection of the contract, whose items the results are. */
function checkScope(contract: AnyContract, name: string, spec: SearchSpec, item: string): void {
  const { scope } = spec;
  if (scope === undefined) {
    return;
  }
  const collection = Object.hasOwn(contract.collections, scope)
    ? contract.collections[scope]
    : undefined;
  if (collection === undefined) {
    fail(`${contract.name}.${name}'s scope "${scope}" is not a collection of ${contract.name}`);
  }
  if (collection.item !== item) {
    fail(
      `${contract.name}.${name}'s results are the items of its scope collection "${scope}", so its item must be "${collection.item}" (pass that projection's schema to search.contract as item), not "${item}"`,
    );
  }
}

/** Why a service cannot run the search kit's handlers made for `contract`. */
function serviceProblem(service: AnyService, contract: AnyContract): string | undefined {
  if (service.contract !== contract) {
    return `its search kit handlers were made for another contract; pass ${service.name}'s own contract to search.handlers`;
  }
  return service.model === undefined
    ? "the search kit reads the service's rows: declare its model"
    : undefined;
}

function handlers<
  C extends AnyContract,
  const A extends SearchAccess<C, M>,
  const M extends SearchMethodsOf<C> = SearchMethodsOf<C>,
>(
  contract: C & NoInfer<SearchContract<C>>,
  options: SearchHandlersOptions<A, M>,
): SearchImplementations<M, A> {
  const { form, strategy, methods } = checkOptions(options, kitMethods(contract));
  const entries: Record<string, object> = {};
  for (const [name, spec] of methods) {
    const projection = itemProjection(contract, name, spec);
    checkScope(contract, name, spec, projection);
    const handler = searchHandler({ spec, form, projection, strategy });
    checkWhenDefined(handler, (service) => serviceProblem(service, contract));
    entries[name] = Object.freeze({ access: form, handler, share: "caller" });
  }
  return Object.freeze(entries) as SearchImplementations<M, A>;
}

/**
 * The search kit: `search.handlers(contract, { access, strategy?, method? })`
 * implements the methods `search.contract` made in `contract` (or the one
 * `method` names), with the access form `access` gives them.
 * `search.contract` is here too, for server code; a shared package imports
 * it from the root export.
 */
export const search = Object.freeze({ contract: contractHalf.contract, handlers });
