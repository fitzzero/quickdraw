// The types of `defineService`'s data options and of what a handler returns
// for a projection output (RFC 0003 sections 3 and 6).
//
// A handler whose method returns a projection returns the database row, and
// the framework projects it: it keeps the projection's keys and sends `Date`
// values as ISO strings. So the handler's return type is the projection's row
// with a `Date` allowed wherever the wire has a string, and extra columns
// allowed (`RowFor`). A projection with a `map` in the service's `project`
// option is built from the row its `select` reads instead: its handlers
// return what `map` takes.

import type { AnyContract } from "../contract/defineContract";
import type { MethodName, MethodOf, ProjectionName, ProjectionOf } from "../contract/infer";
import type { NullableProjection, ProjectionList } from "../contract/methods";
import type { InferOutput, StandardSchemaV1 } from "../contract/standardSchema";

/**
 * A row of a projection as a handler may return it: the database row. Where
 * the projection has a string, a `Date` is accepted too, at any depth (the
 * framework sends its ISO string); and the row may carry more columns than
 * the projection names (the framework sends only the projection's keys).
 */
export type RowFor<Wire> = Wire extends string
  ? Wire | Date
  : Wire extends readonly (infer Item)[]
    ? readonly RowFor<Item>[]
    : Wire extends object
      ? { readonly [Key in keyof Wire]: RowFor<Wire[Key]> }
      : Wire;

/**
 * One projection's entry in `defineService`'s `project` option (RFC 0003
 * section 6).
 */
export interface ProjectionOption<Wire = unknown> {
  /**
   * The projection's keys, for a schema that cannot list them itself (one
   * without Standard JSON Schema, such as a Zod 3 schema). They must include
   * `id`.
   */
  readonly keys?: readonly (keyof Wire & string)[];
  /**
   * What reads of the projection's rows select, in Prisma's `select` shape,
   * instead of its keys: for relations and computed fields. `id` is always
   * selected.
   */
  readonly select?: Readonly<Record<string, unknown>>;
  /**
   * Turns a row read with `select` into the projection's row. Synchronous and
   * pure: it runs for every row sent. Annotate its parameter; handlers of the
   * methods that return this projection return that type. A projection with
   * `map` is always sent whole, never as a patch.
   */
  readonly map?: (row: never) => RowFor<Wire>;
}

/** The `project` option checked against the contract: a name that is not a projection becomes an error message. */
export type ProjectCheck<C extends AnyContract, Proj> = {
  readonly [Name in keyof Proj]: Name extends ProjectionName<C>
    ? ProjectionOption<ProjectionOf<C, Name>>
    : `defineService: "${Name & string}" is not a projection of ${C["name"]}`;
};

/** `[row]` when projection `Name` has a `map` taking `row`, otherwise `[]`. */
type MappedRow<Proj, Name> = Name extends keyof Proj
  ? Proj[Name] extends { readonly map: (row: infer Row) => unknown }
    ? [[Row] extends [never] ? unknown : Row]
    : []
  : [];

/** What a handler returns for one row of projection `Name`: what its `map` takes, or the database row. */
export type HandlerRow<C extends AnyContract, Name extends ProjectionName<C>, Proj> =
  MappedRow<Proj, Name> extends [infer Row] ? Row : RowFor<ProjectionOf<C, Name>>;

type HandlerResult<C extends AnyContract, Output, Proj> = Output extends StandardSchemaV1
  ? InferOutput<Output>
  : Output extends NullableProjection<infer Name extends ProjectionName<C>>
    ? HandlerRow<C, Name, Proj> | null
    : Output extends ProjectionList<infer Name extends ProjectionName<C>>
      ? readonly HandlerRow<C, Name, Proj>[]
      : Output extends ProjectionName<C>
        ? HandlerRow<C, Output, Proj>
        : never;

/**
 * What method `M`'s handler returns: its output schema's type, or, for a
 * projection output, rows as the database returns them (`HandlerRow`),
 * wrapped by `nullable` and `listOf`.
 */
export type HandlerOutputOf<
  C extends AnyContract,
  M extends MethodName<C>,
  Proj = Record<never, never>,
> = HandlerResult<C, MethodOf<C, M>["output"], Proj>;

/**
 * One `affects` entry (RFC 0003 sections 3 and 5.3): a write to a row of the
 * service's model changes a row of `service` too, which is then sent again.
 * `id` is the column of the written row holding that row's id
 * (`"parentTaskId"`), or a function of the written row, with the columns it
 * reads listed in `columns`. Tracked writes report those columns.
 */
export type AffectsOption<Column extends string = string> =
  | {
      readonly service: AnyContract;
      readonly id: Column;
      readonly columns?: undefined;
    }
  | {
      readonly service: AnyContract;
      readonly id: (row: {
        readonly [Key in Column]?: unknown;
      }) => string | readonly string[] | null | undefined;
      readonly columns: readonly Column[];
    };
