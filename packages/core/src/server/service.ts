// A defined service as the pipeline reads it: its contract, and one checked
// record per method holding the handler, the access form and the options.
// `defineService.ts` builds these; the registry and the dispatcher read them.

import type { AnyContract } from "../contract/defineContract";
import type { MethodKind } from "../contract/methods";
import type { StandardSchemaV1 } from "../contract/standardSchema";
import type { Version } from "../protocol/envelope";
import type { AccessForm, AnyAccessPolicy, WatchAccess } from "./access/types";
import type { ServiceCollection } from "./collections/define";
import type { AnyContext, ContextExtender } from "./context";
import type { ProjectedOutput, Projection } from "./emit/projection";
import type { RoomLeaveHandler, ServiceChannel, ServiceStream } from "./realtime/types";
import type { MaybePromise, QuickdrawTypes } from "./types";

/**
 * How identical concurrent calls of a query share one handler run (RFC 0003
 * section 9, step 6): `"caller"` among one principal's calls, `"all"` across
 * principals.
 */
export type ShareMode = "caller" | "all";

/** A handler as the pipeline calls it, whatever its declared types. */
export type AnyHandler = (args: {
  readonly input: unknown;
  readonly ctx: AnyContext;
  readonly db: unknown;
}) => unknown;

/**
 * A method's own output schema, compiled from its JSON Schema when the
 * service is defined (`pipeline/schemaOutput.ts`).
 */
export interface SchemaOutput {
  /** The value reduced to what the schema declares; the value itself when nothing is dropped. */
  pick(value: unknown): unknown;
  /**
   * Each key the schema declares, at any depth, with the first path that
   * declares it (`email`, `user.email`, `[].email`; `{}` stands for any key
   * of a record): what the `tiered-field-in-output` warning reads.
   */
  keyPaths(): ReadonlyMap<string, string>;
}

/** One method of a defined service, checked and ready to dispatch. */
export interface ServiceMethod {
  readonly name: string;
  readonly kind: MethodKind;
  /** The contract's input schema. */
  readonly input: StandardSchemaV1;
  /**
   * The schema the handler's result is checked against in development and
   * tests, derived from the contract's `output`: the schema itself, or the
   * projection's schema, wrapped for `nullable` and `listOf`.
   */
  readonly output: StandardSchemaV1;
  /**
   * The projection the contract's `output` names, when it names one: the
   * handler's rows are projected through it before the output check, and
   * its field tiers are stripped per caller.
   */
  readonly projection: ProjectedOutput | undefined;
  /**
   * A schema output, compiled from its JSON Schema when the service was
   * defined (`pipeline/schemaOutput.ts`): the handler's result is reduced to
   * what the schema declares before the output check, on every transport.
   * `undefined` for a projection output, and for a schema without JSON
   * Schema (Zod 3), which is sent as the handler returns it.
   */
  readonly schemaOutput: SchemaOutput | undefined;
  readonly access: AccessForm;
  readonly handler: AnyHandler;
  readonly share: ShareMode | undefined;
  /** How long a shared result is reused after its run, in milliseconds. */
  readonly ttlMs: number | undefined;
  /** The method's time limit; the dispatcher's `callTimeoutMs` when unset. */
  readonly timeoutMs: number | undefined;
  /** The query's current version for "not modified" replies. */
  readonly version: ((input: unknown, ctx: AnyContext) => MaybePromise<Version>) | undefined;
  /**
   * True when the method said `rowless: true`: its access form is its whole
   * check on purpose, so every caller the form admits may reach any row its
   * input names (`defineService` refuses such a method otherwise; see
   * `buildService.ts`).
   */
  readonly rowless: boolean;
}

/**
 * One `affects` declaration of a service, checked (RFC 0003 sections 3 and
 * 5.3): a write to a row of the service's model also changes rows of
 * `service`, whose ids the written row's `columns` hold.
 */
export interface AffectsLink {
  /** The contract of the service whose rows the write affects. */
  readonly service: AnyContract;
  /** The columns of the service's own model the link reads; tracked writes report them. */
  readonly columns: readonly string[];
  /** The ids of the affected rows, from a written row's values of `columns`. */
  ids(values: Readonly<Record<string, unknown>>): readonly string[];
}

/**
 * A service defined with `qd.defineService(contract, definition)`. Pass it
 * to `qd.createServer` or to a dispatcher.
 */
export interface Service<
  T extends QuickdrawTypes = QuickdrawTypes,
  C extends AnyContract = AnyContract,
> {
  /** The service name from the contract, unchanged on the wire and in stored grants. */
  readonly name: C["name"];
  readonly contract: C;
  /** The database model the service's rows live in, named as the client names it: `"task"`. */
  readonly model: string | undefined;
  /** How a principal's level on one of the service's rows is found (RFC 0003 section 4.2). */
  readonly access: AnyAccessPolicy | undefined;
  /** Other models the service's handlers write, besides its own. */
  readonly writes: readonly string[];
  /** Rows of other services that a write to one of this service's rows changes too. */
  readonly affects: readonly AffectsLink[];
  /** The column whose time says when a row last changed, for "not modified" answers. */
  readonly versionColumn: string | undefined;
  /** The contract's projections (`"entity"` and the named ones), compiled with the service's `project` option. */
  readonly projections: ReadonlyMap<string, Projection>;
  /** The contract's collections, compiled with the service's `collections` option (RFC 0003 section 7.1). */
  readonly collections: ReadonlyMap<string, ServiceCollection>;
  /**
   * Who may watch the service's change topic (RFC 0003 section 11.3);
   * `undefined` when the service set none: the topic is closed to everyone.
   */
  readonly watchAccess: WatchAccess | undefined;
  /** Whether a service-wide `Admin` grant passes every access check of this service. */
  readonly adminBypass: boolean;
  /** The checked method records, by method name. */
  readonly methods: Readonly<Record<string, ServiceMethod>>;
  /** The contract's channels with the handlers `defineService` gave them (RFC 0003 section 12.5). */
  readonly channels: ReadonlyMap<string, ServiceChannel>;
  /** The contract's streams, with their access forms as the access engine decides them. */
  readonly streams: ReadonlyMap<string, ServiceStream>;
  /**
   * The service's own `onRoomLeave`: `createServer` runs it, beside every
   * other service's and its own option's, for each socket that leaves app
   * rooms. `undefined` when the service declares none.
   */
  readonly onRoomLeave: RoomLeaveHandler | undefined;
  /** Type-only: the app types the service was defined with. Never set. */
  readonly "~types"?: T;
}

/** Any defined service. */
export type AnyService = Service<QuickdrawTypes, AnyContract>;

/** What a service keeps from the `initQuickdraw` call that defined it. */
export interface ServiceRuntime {
  /** The app's `context` option, or `undefined`. */
  readonly extendContext: ContextExtender | undefined;
  /**
   * Makes `dispatcher` the one the instance's `qd.caller`, `qd.run`,
   * `qd.stream` and `qd.presence` go through, as its own `createServer`
   * does: for `createTestApp`, which creates its server itself.
   */
  readonly adopt?: (dispatcher: object) => void;
}

const runtimes = new WeakMap<object, ServiceRuntime>();

/** Marks `service` as defined by `defineService` with the given runtime. */
export function registerRuntime(service: AnyService, runtime: ServiceRuntime): void {
  runtimes.set(service, runtime);
}

/** The runtime of a service `defineService` returned, or `undefined` for anything else. */
export function runtimeOf(service: unknown): ServiceRuntime | undefined {
  return typeof service === "object" && service !== null ? runtimes.get(service) : undefined;
}

/** Why a service cannot run a handler, or `undefined` when it can. */
export type HandlerCheck = (service: AnyService) => string | undefined;

const handlerChecks = new WeakMap<object, HandlerCheck>();

/**
 * Makes `defineService` run `check` on the service `handler` is given to, so
 * a handler that needs something of its service (a kit's need a model) fails
 * when the service is defined, not on its first call. Only the kits register
 * checks, so a handler with one is framework code (`isKitHandler`).
 */
export function checkWhenDefined(handler: object, check: HandlerCheck): void {
  handlerChecks.set(handler, check);
}

/** Why `service` cannot run `handler`, from the check `checkWhenDefined` attached. */
export function handlerProblem(handler: object, service: AnyService): string | undefined {
  return handlerChecks.get(handler)?.(service);
}

/**
 * True for a handler a kit made (it registered a check with
 * `checkWhenDefined`): framework code, whose statements the development
 * checks leave alone, because an app cannot change them.
 */
export function isKitHandler(handler: object): boolean {
  return handlerChecks.has(handler);
}

const rowChecked = new WeakSet<object>();

/**
 * Marks a kit handler that never reaches an existing row its input's `id`
 * names without checking the caller's level on that row itself, whatever its
 * access form says: the read/write kit's `update`, `delete` and `reorder`
 * (they need the method's row level on the row) and `create` (its `id`, when
 * it has one, names a new row). `defineService`'s rowless check leaves such
 * a handler alone.
 */
export function checksRowsItself(handler: object): void {
  rowChecked.add(handler);
}

/** True for a handler marked with {@link checksRowsItself}. */
export function isRowChecked(handler: object): boolean {
  return rowChecked.has(handler);
}
