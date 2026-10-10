// Types every server module shares: who is calling (`Principal`), the app's
// own types given once to `initQuickdraw` (`QuickdrawTypes`), and how a call
// arrived (`Transport`). RFC 0003 section 3.

import type { AccessLevel } from "../contract/access";
import type { ContractMap } from "../contract/infer";

/**
 * Who is calling. A transport authenticates the connection or request and
 * hands the dispatcher a principal, or `null` for an anonymous caller. An app
 * declares its own principal type, which extends this one, through
 * `initQuickdraw<{ principal: AppPrincipal }>()`.
 */
export interface Principal {
  /** The user the call acts for. Access policies compare it with owner and member columns. */
  readonly userId: string;
  /** What kind of principal this is, for example `"user"`, `"taskToken"` or `"runner"`. */
  readonly kind?: string;
  /** Verified claims from authentication, such as a token's scopes. */
  readonly claims?: Readonly<Record<string, unknown>>;
  /**
   * Service-wide grants by service name, as 4.x apps store them in
   * `User.serviceAccess`: `{ taskService: "Admin" }`.
   */
  readonly serviceAccess?: Readonly<Record<string, AccessLevel>> | null;
}

/**
 * The app's own types, given once as the type argument of `initQuickdraw`.
 * Every member is optional:
 *
 * - `db`: the database client handlers receive (the app's Prisma client).
 * - `principal`: the app's principal type, extending {@link Principal}.
 * - `context`: the fields `initQuickdraw({ context })` adds to every handler's `ctx`.
 * - `contracts`: the app's contracts (`{ task, project }`), which type `qd.caller`.
 * - `mcp`: the fields the MCP bridge's `context` option gives calls that
 *   arrive over MCP, which handlers read as `ctx.mcp` (token scopes, for example).
 *
 * @example
 * export const qd = initQuickdraw<{ db: AppPrisma; principal: AppPrincipal }>();
 */
export interface QuickdrawTypes {
  readonly db?: unknown;
  readonly principal?: Principal;
  readonly context?: object;
  readonly contracts?: ContractMap;
  readonly mcp?: object;
}

/** The database client handlers receive: `QuickdrawTypes["db"]`, or `unknown` when none is declared. */
export type DbOf<T extends QuickdrawTypes> = T extends { readonly db: infer Db } ? Db : unknown;

/** The app's principal type, or {@link Principal} when none is declared. */
export type PrincipalOf<T extends QuickdrawTypes> = T extends {
  readonly principal: infer P extends Principal;
}
  ? P
  : Principal;

/**
 * The kinds of the app's principal (`"user" | "agent"` when it declares
 * `kind: "user" | "agent"`): what a `kinds` list names. Any string with the
 * base {@link Principal}.
 */
export type PrincipalKindOf<T extends QuickdrawTypes> = NonNullable<PrincipalOf<T>["kind"]>;

/** The fields `initQuickdraw({ context })` adds to every handler's `ctx`. */
export type ContextExtensionOf<T extends QuickdrawTypes> = T extends {
  readonly context: infer Extension extends object;
}
  ? Extension
  : Record<never, never>;

/** `ctx.mcp` when the app's types declare no `mcp`: fields of any value. */
export type McpContext = Readonly<Record<string, unknown>>;

/** The fields of `ctx.mcp`: `QuickdrawTypes["mcp"]`, or {@link McpContext} when none is declared. */
export type McpContextOf<T extends QuickdrawTypes> = T extends {
  readonly mcp: infer Fields extends object;
}
  ? Fields
  : McpContext;

/** How a call reached the dispatcher (RFC 0003 section 10). */
export type Transport = "socket" | "http" | "mcp" | "internal" | "legacy";

/** A value, or a promise of it. */
export type MaybePromise<T> = T | PromiseLike<T>;
