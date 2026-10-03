// Method access forms (RFC 0003 section 4.1) and the `AccessEngine` seam that
// decides them. Every method declares one form; a method without one does not
// compile, and `defineService` rejects it at run time too. 4.1 took a bare
// access level per method and treated a non-entry `Read` method as open to any
// signed-in user (`legacy-src/server/BaseService.ts:567-603`).
//
// The default engine (`basicEngine.ts`) decides `"public"`, `"authenticated"`,
// `{ service }` and `custom(fn)`. `entry` and `scope` need the row-level
// policies of RFC section 4.2, which a later card adds by passing `rows` to
// the basic engine or by replacing the engine.

import type { AccessLevel } from "../../contract/access";
import type { AnyContract } from "../../contract/defineContract";
import type { AnyContext } from "../context";
import type { AnyService } from "../service";
import type { MaybePromise, Principal } from "../types";

/** Anyone may call, with or without credentials. */
export type PublicAccess = "public";

/** Any principal may call; an anonymous caller gets `UNAUTHENTICATED`. */
export type AuthenticatedAccess = "authenticated";

/**
 * The input keys an `id` can name: those holding a string or a list of
 * strings in every input. Any string for an input of unknown type.
 */
export type IdKeyOf<Input> = [Input] extends [never]
  ? string
  : {
      [Key in keyof Input]-?: Input[Key] extends string | readonly string[] ? Key : never;
    }[keyof Input] &
      string;

/**
 * Which row an `entry` or `scope` check is about: the name of an input key
 * holding the row's id (or ids), or a function of the parsed input that
 * returns them.
 */
export type IdSelector<Input = never> =
  | IdKeyOf<Input>
  | ((input: Input) => string | readonly string[]);

/** `{ service: L }`: the principal's service-wide grant on this service is at least `L`. */
export interface ServiceAccess {
  readonly service: AccessLevel;
  readonly entry?: never;
  readonly scope?: never;
  readonly of?: never;
  readonly id?: never;
  readonly kind?: never;
}

/**
 * `{ entry: L, id? }`: the principal's level on the row is at least `L`.
 * With `service: L1` as well, either check passes. `id` defaults to
 * `input.id`, and may be left out only when the input has an `id` string.
 */
export interface EntryAccess<Input = never> {
  readonly entry: AccessLevel;
  readonly service?: AccessLevel;
  readonly id?: IdSelector<Input>;
  readonly scope?: never;
  readonly of?: never;
  readonly kind?: never;
}

/**
 * `{ scope: L, of: contract, id }`: the principal's level on a row of
 * another service is at least `L`, for list and create methods (a task
 * created in a project needs a level on the project).
 */
export interface ScopeAccess<Input = never> {
  readonly scope: AccessLevel;
  readonly of: AnyContract;
  readonly id: IdSelector<Input>;
  readonly entry?: never;
  readonly service?: never;
  readonly kind?: never;
}

/**
 * `custom(fn)`: the call passes when `fn(ctx, input)` resolves `true`. The
 * caller must be authenticated before `fn` runs, so `ctx.principal` is never
 * `null` inside it.
 */
export interface CustomAccess<Input = never, Ctx = never> {
  readonly kind: "custom";
  readonly check: (ctx: Ctx, input: Input) => MaybePromise<boolean>;
}

/** Any access form, as the pipeline and an access engine see it. */
export type AccessForm<Input = never, Ctx = never> =
  | PublicAccess
  | AuthenticatedAccess
  | ServiceAccess
  | EntryAccess<Input>
  | ScopeAccess<Input>
  | CustomAccess<Input, Ctx>;

/**
 * The access forms a method whose parsed input is `Input` may declare. An
 * `entry` form may leave out `id` only when every input has an `id` string;
 * there is no run-time sniffing of payloads.
 */
export type AccessFor<Input, Ctx> =
  | PublicAccess
  | AuthenticatedAccess
  | ServiceAccess
  | ([Input] extends [{ readonly id: string }]
      ? EntryAccess<Input>
      : EntryAccess<Input> & { readonly id: IdSelector<Input> })
  | ScopeAccess<Input>
  | CustomAccess<Input, Ctx>;

/** What an access check is about. */
export interface AccessRequest {
  /** The service whose method is being called. */
  readonly service: AnyService;
  /** The method's name. */
  readonly method: string;
  /** The caller, or `null` when anonymous. */
  readonly principal: Principal | null;
  /** The input after its schema ran. */
  readonly input: unknown;
  /** The call's context, which `custom` checks receive. */
  readonly ctx: AnyContext;
}

/**
 * Decides whether a call may proceed: the pipeline's authorization stage
 * (RFC 0003 section 9, step 4). It resolves when the call is allowed and
 * rejects with a `QuickdrawError` when it is not: `UNAUTHENTICATED` without a
 * principal, `FORBIDDEN` when the principal's level is too low.
 *
 * The dispatcher's default is `createBasicAccessEngine()`. The access
 * policies card replaces it, or passes its policies to the basic engine as
 * `rows`, without touching the pipeline.
 */
export interface AccessEngine {
  authorize(form: AccessForm, request: AccessRequest): MaybePromise<void>;
}

/**
 * Decides the row-level forms, `entry` and `scope`, from the access policies
 * of RFC 0003 section 4.2. It answers whether the principal's level on the
 * row (or every row, when the selector yields several ids) is high enough,
 * or rejects with a `QuickdrawError` of its own (for example `NOT_FOUND`).
 * The basic engine has already handled the anonymous caller, the service
 * admin bypass and the `service` half of a combined form.
 */
export interface RowAccess {
  allows(form: EntryAccess | ScopeAccess, request: AccessRequest): MaybePromise<boolean>;
}
