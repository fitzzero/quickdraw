// A defined service as the pipeline reads it: its contract, and one checked
// record per method holding the handler, the access form and the options.
// `defineService.ts` builds these; the registry and the dispatcher read them.

import type { AnyContract } from "../contract/defineContract";
import type { MethodKind } from "../contract/methods";
import type { StandardSchemaV1 } from "../contract/standardSchema";
import type { Version } from "../protocol/envelope";
import type { AccessForm } from "./access/types";
import type { AnyContext, ContextExtender } from "./context";
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
  readonly access: AccessForm;
  readonly handler: AnyHandler;
  readonly share: ShareMode | undefined;
  /** How long a shared result is reused after its run, in milliseconds. */
  readonly ttlMs: number | undefined;
  /** The method's time limit; the dispatcher's `callTimeoutMs` when unset. */
  readonly timeoutMs: number | undefined;
  /** The query's current version for "not modified" replies. */
  readonly version: ((input: unknown, ctx: AnyContext) => MaybePromise<Version>) | undefined;
}

/**
 * A service defined with `qd.defineService(contract, definition)`. Pass it
 * to the dispatcher (and, later, to `qd.createServer`).
 */
export interface Service<
  T extends QuickdrawTypes = QuickdrawTypes,
  C extends AnyContract = AnyContract,
> {
  /** The service name from the contract, unchanged on the wire and in stored grants. */
  readonly name: C["name"];
  readonly contract: C;
  /** Whether a service-wide `Admin` grant passes every access check of this service. */
  readonly adminBypass: boolean;
  /** The checked method records, by method name. */
  readonly methods: Readonly<Record<string, ServiceMethod>>;
  /** Type-only: the app types the service was defined with. Never set. */
  readonly "~types"?: T;
}

/** Any defined service. */
export type AnyService = Service<QuickdrawTypes, AnyContract>;

/** What a service keeps from the `initQuickdraw` call that defined it. */
export interface ServiceRuntime {
  /** The app's `context` option, or `undefined`. */
  readonly extendContext: ContextExtender | undefined;
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
