// Types derived from a contract. `defineService` (RFC 0003 section 3) and the
// client proxy (section 11) build their method, entity, collection and view
// types from these, so a service is described once, in its contract.
//
// Input and output follow the caller's side of the wire: `InputOf` is what a
// caller passes (the input schema's input type) and `OutputOf` is what the
// caller receives. A handler receives `ParsedInputOf`, the input after its
// schema ran (defaults applied, transforms done).
//
// Rows follow the reader's side too. `EntityOf`, `ProjectionOf`, `ItemOf` and
// the projection outputs of `OutputOf` are rows as a reader receives them: a
// key the contract's `fields` map tiers is optional, because a reader below
// its level receives the row without it (RFC 0003 section 6). What a handler
// returns keeps every key (`FullProjectionOf`, through the server's
// `HandlerOutputOf`).

import type { AnyContract, IndexRow } from "./defineContract";
import type { NullableProjection, ProjectionList } from "./methods";
import type { InferInput, InferOutput, StandardSchemaV1 } from "./standardSchema";

/** A map of contracts, as the client is created from: `{ task, project, chat }`. */
export type ContractMap = { readonly [key: string]: AnyContract };

/** The service name of a contract. */
export type ServiceNameOf<C extends AnyContract> = C["name"];

/** `"entity"` (when the contract has one) plus the names of its projections. */
export type ProjectionName<C extends AnyContract> =
  | (C["entity"] extends StandardSchemaV1 ? "entity" : never)
  | (keyof C["projections"] & string);

/**
 * The full row of a projection, every key present: its schema's output
 * (`"entity"` is the entity's). The server builds this row and strips each
 * reader's tiers from it; a handler returns it (`HandlerOutputOf`).
 */
export type FullProjectionOf<
  C extends AnyContract,
  P extends ProjectionName<C>,
> = P extends "entity"
  ? C["entity"] extends StandardSchemaV1
    ? InferOutput<C["entity"]>
    : never
  : P extends keyof C["projections"]
    ? InferOutput<C["projections"][P]>
    : never;

/** `T` with its properties listed in one object type, for readable hovers and errors. */
type Flatten<T> = { [K in keyof T]: T[K] };

/** `Row` with the keys in `Tiered` optional; any other key, and a row with none of them, unchanged. */
type OptionalKeys<Row, Tiered extends PropertyKey> = Row extends object
  ? [Extract<keyof Row, Tiered>] extends [never]
    ? Row
    : Flatten<
        { [K in keyof Row as K extends Tiered ? never : K]: Row[K] } & {
          [K in keyof Row as K extends Tiered ? K : never]?: Row[K];
        }
      >
  : Row;

/**
 * `Row`, a row of contract `C`, as a reader receives it: each key the
 * contract's `fields` map tiers is optional, since a reader below its level
 * receives the row without it.
 */
export type ReceivedRow<C extends AnyContract, Row> = OptionalKeys<Row, keyof C["fields"]>;

/**
 * The entity row of a contract as a reader receives it (`useEntity`,
 * `"entity"` outputs): a field the contract's `fields` map tiers is
 * optional. `never` for a contract without an entity.
 */
export type EntityOf<C extends AnyContract> = C["entity"] extends StandardSchemaV1
  ? ReceivedRow<C, InferOutput<C["entity"]>>
  : never;

/**
 * The row type of a projection as a reader receives it; `"entity"` is the
 * entity. A field the contract's `fields` map tiers is optional
 * (`FullProjectionOf` has it).
 */
export type ProjectionOf<C extends AnyContract, P extends ProjectionName<C>> = ReceivedRow<
  C,
  FullProjectionOf<C, P>
>;

/** The names of a contract's methods. */
export type MethodName<C extends AnyContract> = keyof C["methods"] & string;

/** One method's declaration: `kind`, `input`, `output` and `watch`. */
export type MethodOf<C extends AnyContract, M extends MethodName<C>> = C["methods"][M];

/** `"query"` or `"mutation"`. */
export type KindOf<C extends AnyContract, M extends MethodName<C>> = MethodOf<C, M>["kind"];

/** What a caller passes to a method. */
export type InputOf<C extends AnyContract, M extends MethodName<C>> = InferInput<
  MethodOf<C, M>["input"]
>;

/** What a method's handler receives: the input after its schema ran. */
export type ParsedInputOf<C extends AnyContract, M extends MethodName<C>> = InferOutput<
  MethodOf<C, M>["input"]
>;

type ResolveOutput<C extends AnyContract, Output> = Output extends StandardSchemaV1
  ? InferOutput<Output>
  : Output extends NullableProjection<infer P extends ProjectionName<C>>
    ? ProjectionOf<C, P> | null
    : Output extends ProjectionList<infer P extends ProjectionName<C>>
      ? ProjectionOf<C, P>[]
      : Output extends ProjectionName<C>
        ? ProjectionOf<C, Output>
        : never;

/** What a caller receives from a method: its output schema's type, or the projection rows it names. */
export type OutputOf<C extends AnyContract, M extends MethodName<C>> = ResolveOutput<
  C,
  MethodOf<C, M>["output"]
>;

/** The names of a contract's collections. */
export type CollectionName<C extends AnyContract> = keyof C["collections"] & string;

/** One collection's declaration. */
export type CollectionOf<C extends AnyContract, K extends CollectionName<C>> = C["collections"][K];

/**
 * The item type of a collection: the row of the projection it declares as
 * `item`, as a reader receives it (a tiered field is optional).
 */
export type ItemOf<C extends AnyContract, K extends CollectionName<C>> =
  CollectionOf<C, K>["item"] extends ProjectionName<C>
    ? ProjectionOf<C, CollectionOf<C, K>["item"]>
    : never;

/**
 * The value that identifies one scope of a collection: the type of its scope
 * column, or `string` for a `via(...)` scope.
 */
export type ScopeOf<C extends AnyContract, K extends CollectionName<C>> = CollectionOf<
  C,
  K
>["scope"] extends keyof EntityOf<C>
  ? NonNullable<EntityOf<C>[CollectionOf<C, K>["scope"]]>
  : string;

/** The index fields of a collection, or `never` when it declares no index. */
export type IndexFieldOf<C extends AnyContract, K extends CollectionName<C>> = CollectionOf<
  C,
  K
>["index"] extends readonly (infer Field extends string)[]
  ? Field
  : never;

/**
 * One index row of a collection: `id` plus its index fields. What a view
 * predicate reads. Every subscriber receives every index field (a collection
 * refuses one its `fields` tier hides at the collection's access), so a
 * tiered index field is not optional here.
 */
export type IndexRowOf<C extends AnyContract, K extends CollectionName<C>> = IndexRow<
  CollectionOf<C, K>["item"] extends ProjectionName<C>
    ? FullProjectionOf<C, CollectionOf<C, K>["item"]>
    : never,
  IndexFieldOf<C, K>
>;

/** The names of a collection's views. */
export type ViewName<C extends AnyContract, K extends CollectionName<C>> = keyof NonNullable<
  CollectionOf<C, K>["views"]
> &
  string;

/** The names of a contract's streams. */
export type StreamName<C extends AnyContract> = keyof C["streams"] & string;

/** The names of a contract's channels. */
export type ChannelName<C extends AnyContract> = keyof C["channels"] & string;

/** The names of a contract's typed room events. */
export type EventName<C extends AnyContract> = keyof C["events"] & string;

/** The item type of a stream: what `push` takes and subscribers receive. */
export type StreamItemOf<C extends AnyContract, K extends StreamName<C>> = InferOutput<
  C["streams"][K]["item"]
>;

/**
 * `true` when a stream has one feed per scope value (it declares a `scope`
 * other than `"global"`), `false` for a stream with one feed for the service.
 */
export type IsScopedStream<
  C extends AnyContract,
  K extends StreamName<C>,
> = C["streams"][K] extends {
  readonly scope: infer Scope extends string;
}
  ? Scope extends "global"
    ? false
    : true
  : false;

/** The payload type of a channel, as its handler receives it (after its schema ran). */
export type ChannelPayloadOf<C extends AnyContract, K extends ChannelName<C>> = InferOutput<
  C["channels"][K]["payload"]
>;

/** What a client sends on a channel: its payload schema's input type. */
export type ChannelInputOf<C extends AnyContract, K extends ChannelName<C>> = InferInput<
  C["channels"][K]["payload"]
>;

/** The payload type of a custom event: what `ctx.rooms.emit` takes and `useEvent` receives. */
export type EventPayloadOf<C extends AnyContract, K extends EventName<C>> = InferOutput<
  C["events"][K]["payload"]
>;
