// `defineContract`: one schema source per service (RFC 0003 section 2). A
// contract is plain data plus schemas, so browser code imports it without any
// server code. Every server and client type is derived from it: see
// `infer.ts`. In 4.1 the same information was spread over a hand-written
// method map, an optional Zod schema per method, seven generics on
// `BaseService` (`legacy-src/server/BaseService.ts:68-80`) and room-name
// helpers.

import type { AccessLevel } from "./access";
import type { CollectionDef, OrderBy, ViaScope, ViewPredicate } from "./collections";
import type { MethodDef, ProjectionRef } from "./methods";
import type { InferOutput, StandardSchemaV1 } from "./standardSchema";
import { assembleContract } from "./validateContract";

/** A schema whose output is a row: an object with `id: string`. */
export type RowSchema = StandardSchemaV1<unknown, { readonly id: string }>;

/** A server-to-client stream of append-only items (RFC 0003 section 12.5). */
export interface StreamDef<Item extends StandardSchemaV1 = StandardSchemaV1> {
  readonly item: Item;
}

/** A client-to-server fire-and-forget channel (RFC 0003 section 12.5). */
export interface ChannelDef<Payload extends StandardSchemaV1 = StandardSchemaV1> {
  readonly payload: Payload;
}

/** A typed custom room event, delivered as `qd:event` (RFC 0003 section 8.3). */
export interface EventDef<Payload extends StandardSchemaV1 = StandardSchemaV1> {
  readonly payload: Payload;
}

/** The second argument of {@link defineContract}. */
export interface ContractDefinition {
  /**
   * The full row; its output must contain `id: string`. Omit it for a service
   * without a model, which then has no projections, fields or collections.
   *
   * Typed `unknown` here on purpose: `defineContract` checks it through its
   * own `Entity` parameter. Constraining it here as well makes TypeScript
   * reject Zod 3 schemas whenever a collection declares `views`.
   */
  readonly entity?: unknown;
  /** Named lean shapes of the entity. `"entity"` itself is implicit. */
  readonly projections?: { readonly [name: string]: RowSchema };
  /** The minimum level a subscriber needs to receive each entity field. */
  readonly fields?: { readonly [field: string]: AccessLevel };
  /** Every method is a `query(...)` or a `mutation(...)`. */
  readonly methods?: { readonly [name: string]: MethodDef };
  /** Live lists of the entity, grouped by a scope value. */
  readonly collections?: { readonly [name: string]: CollectionDef };
  readonly streams?: { readonly [name: string]: StreamDef };
  readonly channels?: { readonly [name: string]: ChannelDef };
  readonly events?: { readonly [name: string]: EventDef };
}

type Empty = Record<never, never>;
type MemberOf<Def, Key extends string, Absent> = Def extends { readonly [K in Key]: infer Value }
  ? Value
  : Absent;

/**
 * A defined contract: the definition with every member present (an absent
 * one is `undefined` for `entity` and `{}` otherwise) plus the service name.
 */
export interface Contract<
  Name extends string = string,
  Def extends ContractDefinition = ContractDefinition,
> {
  /** The service name, unchanged on the wire and in stored grants. */
  readonly name: Name;
  readonly entity: MemberOf<Def, "entity", undefined>;
  readonly projections: MemberOf<Def, "projections", Empty>;
  readonly fields: MemberOf<Def, "fields", Empty>;
  readonly methods: MemberOf<Def, "methods", Empty>;
  readonly collections: MemberOf<Def, "collections", Empty>;
  readonly streams: MemberOf<Def, "streams", Empty>;
  readonly channels: MemberOf<Def, "channels", Empty>;
  readonly events: MemberOf<Def, "events", Empty>;
}

/** Any contract. Every contract `defineContract` returns is assignable to it. */
export interface AnyContract {
  readonly name: string;
  readonly entity: RowSchema | undefined;
  readonly projections: { readonly [name: string]: RowSchema };
  readonly fields: { readonly [field: string]: AccessLevel };
  readonly methods: { readonly [name: string]: MethodDef };
  readonly collections: { readonly [name: string]: CollectionDef };
  readonly streams: { readonly [name: string]: StreamDef };
  readonly channels: { readonly [name: string]: ChannelDef };
  readonly events: { readonly [name: string]: EventDef };
}

// ---------------------------------------------------------------------------
// Definition context: the types that check each member against the entity
// and projections, and give `views` predicates their row type. `Entity`,
// `Projections`, `Items` and `Indexes` are inferred from the plain-data parts
// of the definition before TypeScript types the predicates; everything else
// sits behind `NoInfer` so it checks without steering that inference.
// ---------------------------------------------------------------------------

type SchemaOutput<Schema> = Schema extends StandardSchemaV1 ? InferOutput<Schema> : never;

type ProjectionRow<Entity, Projections, Name> = Name extends "entity"
  ? SchemaOutput<Entity>
  : Name extends keyof Projections
    ? SchemaOutput<Projections[Name]>
    : never;

/** Entity columns whose values are strings: the columns a collection can be scoped by. */
type StringColumn<Row> = {
  [Column in keyof Row]-?: NonNullable<Row[Column]> extends string ? Column : never;
}[keyof Row];

type IndexField<Item> = Exclude<keyof Item, "id">;

type IndexedFields<Index> = Index extends readonly (infer Field)[] ? Field : never;

/** An index row: `id` plus the collection's `index` fields of the item. */
export type IndexRow<Item, Fields> = Pick<Item, Extract<keyof Item, "id" | Fields>>;

// Without an entity any column name passes here, so the checks below report
// "collections need an entity" instead of a column error. The `& string`
// makes an error message list the allowed names rather than print the name of
// the type that computes them.
type ColumnOf<Row> = [Row] extends [never] ? string : keyof Row & string;
type ScopeColumnOf<Row> = [Row] extends [never] ? string : StringColumn<Row> & string;

interface CollectionContext<Row, Entity, Projections, Item, Index> {
  readonly scope: NoInfer<ViaScope | ScopeColumnOf<Row>>;
  readonly item: Item;
  readonly order: NoInfer<OrderBy<ColumnOf<Row>>>;
  readonly where?: NoInfer<{ readonly [Column in ColumnOf<Row>]?: unknown }>;
  readonly index?: NoInfer<
    readonly (IndexField<ProjectionRow<Entity, Projections, Item>> & string)[]
  >;
  readonly views?: NoInfer<{
    readonly [view: string]: ViewPredicate<
      IndexRow<ProjectionRow<Entity, Projections, Item>, IndexedFields<Index>>
    >;
  }>;
}

type DefinitionContext<Entity, Projections, Items, Indexes> = {
  readonly entity?: Entity;
  readonly projections?: Projections;
  readonly fields?: NoInfer<{
    readonly [Field in Exclude<keyof SchemaOutput<Entity>, "id">]?: AccessLevel;
  }>;
  readonly collections?: {
    readonly [Name in keyof Items]: CollectionContext<
      SchemaOutput<Entity>,
      Entity,
      Projections,
      Items[Name],
      Name extends keyof Indexes ? Indexes[Name] : undefined
    >;
  } & { readonly [Name in keyof Indexes]: { readonly index?: Indexes[Name] } };
};

// ---------------------------------------------------------------------------
// Definition checks: rules a structural type cannot state. A broken rule turns
// the offending member's type into a message, which the compiler prints. A
// message replaces a whole object (a collection, the fields map) rather than
// one literal inside it: TypeScript would reduce two conflicting literals to
// `never` and print that instead.
// ---------------------------------------------------------------------------

/**
 * Member names the protocol and the client proxy reserve, besides any name
 * starting with `$`: `useEntity`, `useEntities` and `admin` sit beside a
 * service's methods and collections on `qd.<service>`.
 */
export type ReservedMethodName =
  | "subscribe"
  | "unsubscribe"
  | "call"
  | "useEntity"
  | "useEntities"
  | "admin";

type Problem<Text extends string> = `defineContract: ${Text}`;

type IsReserved<Name> = Name extends ReservedMethodName | `$${string}` ? true : false;

type HasEntity<Def> = Def extends { readonly entity: object } ? true : false;

type DefinedRow<Def> = Def extends { readonly entity: infer Entity } ? SchemaOutput<Entity> : never;

type MethodsIn<Def> = MemberOf<Def, "methods", Empty>;
type CollectionsIn<Def> = MemberOf<Def, "collections", Empty>;
type ProjectionsIn<Def> = MemberOf<Def, "projections", Empty>;
type FieldsIn<Def> = MemberOf<Def, "fields", Empty>;

type ProjectionNameIn<Def> =
  | (HasEntity<Def> extends true ? "entity" : never)
  | (keyof ProjectionsIn<Def> & string);

type CheckKeys<Value, Allowed, Owner extends string> = {
  readonly [Key in keyof Value]: Key extends Allowed
    ? unknown
    : Problem<`"${Key & string}" is not a ${Owner} option`>;
};

interface MethodCheck<Def> {
  readonly output: StandardSchemaV1 | ProjectionRef<ProjectionNameIn<Def> & string>;
  readonly watch?: { readonly collection: keyof CollectionsIn<Def> & string } | undefined;
}

type CheckMethods<Def> = {
  readonly [Name in keyof MethodsIn<Def>]: IsReserved<Name> extends true
    ? Problem<`"${Name & string}" is a reserved method name`>
    : MethodCheck<Def>;
};

type Quoted<Names> = `"${Names & string}"`;

type CollectionProblem<Def, Name, Collection> =
  IsReserved<Name> extends true
    ? `"${Name & string}" is a reserved name`
    : Name extends keyof MethodsIn<Def>
      ? `collection "${Name & string}" has the same name as a method`
      : [Exclude<keyof Collection, keyof CollectionDef>] extends [never]
        ? Collection extends { readonly item: ProjectionNameIn<Def> }
          ? never
          : `collection "${Name & string}": item is not "entity" or a key of projections`
        : `collection "${Name & string}" has no option ${Quoted<Exclude<keyof Collection, keyof CollectionDef>>}`;

type MismatchedColumns<Row, Where> = {
  [Column in keyof Where]: Column extends keyof Row
    ? Where[Column] extends Row[Column]
      ? never
      : Column
    : Column;
}[keyof Where];

type CheckWhere<Def, Collection> = Collection extends { readonly where: infer Where }
  ? [MismatchedColumns<DefinedRow<Def>, Where>] extends [never]
    ? unknown
    : {
        readonly where: Problem<`where: ${Quoted<MismatchedColumns<DefinedRow<Def>, Where>>} is not a field of the entity, or the value does not match its type`>;
      }
  : unknown;

type CheckViews<Collection> = Collection extends { readonly views: object }
  ? Collection extends { readonly index: readonly string[] }
    ? unknown
    : { readonly views: Problem<"views read index rows, so the collection needs an index"> }
  : unknown;

type CheckCollection<Def, Name, Collection> =
  HasEntity<Def> extends true
    ? [CollectionProblem<Def, Name, Collection>] extends [never]
      ? CheckWhere<Def, Collection> & CheckViews<Collection>
      : Problem<CollectionProblem<Def, Name, Collection>>
    : Problem<"collections need an entity">;

type CheckCollections<Def> = {
  readonly [Name in keyof CollectionsIn<Def>]: CheckCollection<Def, Name, CollectionsIn<Def>[Name]>;
};

type CheckProjections<Def> = {
  readonly [Name in keyof ProjectionsIn<Def>]: HasEntity<Def> extends true
    ? Name extends "entity"
      ? Problem<`"entity" is implicit; give this projection another name`>
      : unknown
    : Problem<"projections need an entity">;
};

type UnknownFields<Def> = Exclude<keyof FieldsIn<Def>, Exclude<keyof DefinedRow<Def>, "id">>;

type CheckFields<Def> = [keyof FieldsIn<Def>] extends [never]
  ? unknown
  : HasEntity<Def> extends true
    ? [UnknownFields<Def>] extends [never]
      ? unknown
      : Problem<`fields: ${Quoted<UnknownFields<Def>>} is not a field of the entity, or is "id", which every subscriber receives`>
    : Problem<"fields need an entity">;

type DefinitionChecks<Def> = CheckKeys<Def, keyof ContractDefinition, "contract"> & {
  readonly methods?: CheckMethods<Def>;
  readonly collections?: CheckCollections<Def>;
  readonly projections?: CheckProjections<Def>;
  readonly fields?: CheckFields<Def>;
};

/**
 * Defines the contract of one service: its entity, projections, field tiers,
 * methods, collections, streams, channels and events.
 *
 * The rules are checked by type, so a mistake fails to compile where it is
 * written, and again when the contract is defined, so JavaScript callers and
 * casts get an error too. A Standard Schema does not expose its keys, so some
 * rules can only be checked by type: that `fields`, `scope`, `order`, `where`
 * and `index` name real fields, and that a view reads only index fields.
 *
 * The type parameters after `Def` only exist so TypeScript can type `views`
 * predicates; never pass them.
 *
 * @example
 * export const task = defineContract("taskService", {
 *   entity: taskSchema,
 *   projections: { card: taskCardSchema },
 *   fields: { internalNotes: "Admin" },
 *   methods: {
 *     get: query({ input: z.object({ id: z.string() }), output: "entity" }),
 *     rename: mutation({ input: renameSchema, output: "entity" }),
 *   },
 *   collections: {
 *     byProject: {
 *       scope: "projectId",
 *       item: "card",
 *       order: [["ordinal", "asc"], ["id", "asc"]],
 *       index: ["status", "assigneeId"],
 *       views: { mine: (row, who) => row.assigneeId === who.userId },
 *     },
 *   },
 * });
 */
export function defineContract<
  const Name extends string,
  const Def extends ContractDefinition,
  Entity extends RowSchema = never,
  Projections = Empty,
  Items = Empty,
  Indexes = Empty,
>(
  name: Name,
  def: Def &
    DefinitionContext<Entity, Projections, Items, Indexes> &
    NoInfer<DefinitionChecks<Def>>,
): Contract<Name, Def> {
  return assembleContract(name, def) as unknown as Contract<Name, Def>;
}
