// Method declarations for a contract (RFC 0003 section 2). Every method is a
// `query` or a `mutation`, and both `input` and `output` are required. This
// replaces the 4.1 hand-written `ServiceMethodsMap` plus the optional Zod
// schema passed to `defineMethod` (`legacy-src/server/BaseService.ts:848-851`).

import type { InferInput, StandardSchemaV1 } from "./standardSchema";

/**
 * A query reads; a mutation writes. The kind decides request sharing,
 * cancellation, the per-socket concurrency cap, the HTTP verb, the MCP
 * read-only hint and which client hook exists.
 */
export type MethodKind = "query" | "mutation";

/** The name of the implicit projection: the full entity. */
export type EntityProjection = "entity";

/** `nullable("entity")`: one row of a projection, or `null`. */
export interface NullableProjection<Projection extends string = string> {
  readonly kind: "nullable";
  readonly projection: Projection;
}

/** `listOf("card")`: an array of rows of a projection. */
export interface ProjectionList<Projection extends string = string> {
  readonly kind: "list";
  readonly projection: Projection;
}

/** A method output given as a projection: its name, optionally wrapped. */
export type ProjectionRef<Projection extends string = string> =
  | Projection
  | NullableProjection<Projection>
  | ProjectionList<Projection>;

/** What a method returns: any Standard Schema, or a projection of the entity. */
export type MethodOutput = StandardSchemaV1 | ProjectionRef;

/**
 * Declares that a query reads one scope of one of the contract's collections.
 * The client joins that topic and invalidates the query when the scope changes
 * (RFC 0003 section 11.3). `scope` receives the input exactly as the caller
 * passed it.
 */
export interface Watch<Collection extends string = string, Input = never> {
  readonly collection: Collection;
  readonly scope: (input: Input) => string;
}

/**
 * `watch: { service: ["gameScore"] }`: the service's change topic, narrowed
 * to the models named (finding F7.3 of the quickdraw-chat review): the
 * query is invalidated only after a flush that changed one of them. The
 * names are models of the service, by the client's model name: its `model`
 * and those it lists in `writes`; `defineService` refuses any other.
 */
export interface ServiceModelsWatch {
  readonly service: readonly string[];
}

/**
 * `watch: "service"`: the query reads what the service's change topic covers
 * (its rows, its collections, and the models it lists in `writes`, such as
 * a game's high scores), so it is invalidated after every flush that
 * changes any of them. `watch: { service: [models] }` is invalidated only
 * when one of the models named changed. The service must open its topic
 * with `watchAccess`.
 */
export type ServiceWatch = "service" | ServiceModelsWatch;

/** A `query` as `defineContract` stores it. */
export interface QueryDef<
  Input extends StandardSchemaV1 = StandardSchemaV1,
  Output extends MethodOutput = MethodOutput,
  Watched extends string = never,
> {
  readonly kind: "query";
  readonly input: Input;
  readonly output: Output;
  /**
   * The topic the query watches: a collection scope (`Watched` is then the
   * collection's name), or `"service"`, its service's own topic, or
   * `{ service: [models] }`, that topic narrowed to the models named.
   */
  readonly watch?:
    | ([Watched] extends [never] ? ServiceWatch : Watch<Watched, InferInput<Input>>)
    | undefined;
  /** What the method does, in a sentence or two. The MCP bridge uses it as the tool's description. */
  readonly describe?: string | undefined;
}

/** A `mutation` as `defineContract` stores it. Mutations never watch. */
export interface MutationDef<
  Input extends StandardSchemaV1 = StandardSchemaV1,
  Output extends MethodOutput = MethodOutput,
> {
  readonly kind: "mutation";
  readonly input: Input;
  readonly output: Output;
  readonly watch?: undefined;
  /** What the method does, in a sentence or two. The MCP bridge uses it as the tool's description. */
  readonly describe?: string | undefined;
}

/** Any method of any contract. */
export interface MethodDef {
  readonly kind: MethodKind;
  readonly input: StandardSchemaV1;
  readonly output: MethodOutput;
  readonly watch?: Watch<string> | ServiceWatch | undefined;
  readonly describe?: string | undefined;
}

/**
 * A read. `output` is a schema or a projection name (`"entity"` or a key of
 * the contract's `projections`), optionally wrapped in `nullable` or `listOf`.
 * `describe` says what the method does, for people and agents: the MCP
 * bridge uses it as the tool's description.
 *
 * @example
 * get: query({ input: z.object({ id: z.string() }), output: "entity", describe: "Reads one task" })
 */
export function query<
  const Input extends StandardSchemaV1,
  const Output extends MethodOutput,
  const Watched extends string = never,
>(def: {
  readonly input: Input;
  readonly output: Output;
  readonly watch?: Watch<Watched, InferInput<Input>> | ServiceWatch;
  readonly describe?: string;
}): QueryDef<Input, Output, NoInfer<Watched>> {
  // `NoInfer` in the return type: inside `defineContract`, TypeScript would
  // otherwise infer `Watched` from the surrounding contract as `string` for a
  // query that does not watch, and the watch check would then reject it.
  // Absent options stay absent rather than becoming `undefined` members.
  // A collection watch names `Watched`; `"service"` leaves it `never`, as the type says.
  const method = {
    kind: "query",
    input: def.input,
    output: def.output,
    ...(def.watch === undefined ? {} : { watch: def.watch }),
    ...(def.describe === undefined ? {} : { describe: def.describe }),
  } as QueryDef<Input, Output, Watched>;
  return Object.freeze(method);
}

/**
 * A write. `output` and `describe` follow the same rules as `query`; a
 * mutation cannot `watch`.
 *
 * @example
 * rename: mutation({ input: renameSchema, output: "entity" })
 */
export function mutation<
  const Input extends StandardSchemaV1,
  const Output extends MethodOutput,
>(def: {
  readonly input: Input;
  readonly output: Output;
  readonly describe?: string;
}): MutationDef<Input, Output> {
  const method: MutationDef<Input, Output> = {
    kind: "mutation",
    input: def.input,
    output: def.output,
    ...(def.describe === undefined ? {} : { describe: def.describe }),
  };
  return Object.freeze(method);
}

/** A method output of one projection row, or `null` when there is none. */
export function nullable<const Projection extends string>(
  projection: Projection,
): NullableProjection<Projection> {
  return Object.freeze({ kind: "nullable", projection });
}

/** A method output of an array of projection rows. */
export function listOf<const Projection extends string>(
  projection: Projection,
): ProjectionList<Projection> {
  return Object.freeze({ kind: "list", projection });
}
