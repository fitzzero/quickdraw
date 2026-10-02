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

/** A `query` as `defineContract` stores it. */
export interface QueryDef<
  Input extends StandardSchemaV1 = StandardSchemaV1,
  Output extends MethodOutput = MethodOutput,
  Watched extends string = never,
> {
  readonly kind: "query";
  readonly input: Input;
  readonly output: Output;
  readonly watch?: Watch<Watched, InferInput<Input>> | undefined;
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
}

/** Any method of any contract. */
export interface MethodDef {
  readonly kind: MethodKind;
  readonly input: StandardSchemaV1;
  readonly output: MethodOutput;
  readonly watch?: Watch<string> | undefined;
}

/**
 * A read. `output` is a schema or a projection name (`"entity"` or a key of
 * the contract's `projections`), optionally wrapped in `nullable` or `listOf`.
 *
 * @example
 * get: query({ input: z.object({ id: z.string() }), output: "entity" })
 */
export function query<
  const Input extends StandardSchemaV1,
  const Output extends MethodOutput,
  const Watched extends string = never,
>(def: {
  readonly input: Input;
  readonly output: Output;
  readonly watch?: Watch<Watched, InferInput<Input>>;
}): QueryDef<Input, Output, NoInfer<Watched>> {
  // `NoInfer` in the return type: inside `defineContract`, TypeScript would
  // otherwise infer `Watched` from the surrounding contract as `string` for a
  // query that does not watch, and the watch check would then reject it.
  const method: QueryDef<Input, Output, Watched> =
    def.watch === undefined
      ? { kind: "query", input: def.input, output: def.output }
      : { kind: "query", input: def.input, output: def.output, watch: def.watch };
  return Object.freeze(method);
}

/**
 * A write. `output` follows the same rules as `query`; a mutation cannot
 * `watch`.
 *
 * @example
 * rename: mutation({ input: renameSchema, output: "entity" })
 */
export function mutation<
  const Input extends StandardSchemaV1,
  const Output extends MethodOutput,
>(def: { readonly input: Input; readonly output: Output }): MutationDef<Input, Output> {
  return Object.freeze({ kind: "mutation", input: def.input, output: def.output });
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
