// The default `AccessEngine`. It decides the forms that need no row lookup
// (`"public"`, `"authenticated"`, `{ service }`, `custom(fn)`) and hands the
// row-level forms (`entry`, `scope`) to a `RowAccess`, which the access
// policies card provides. Without one, a row-level form fails with
// `INTERNAL`: a configuration mistake, never a silent pass.

import { QuickdrawError } from "../../protocol/errors";
import type { AnyContext } from "../context";
import type { MaybePromise } from "../types";
import { isCustomAccess } from "./forms";
import { meetsLevel, serviceGrant } from "./levels";
import type { AccessEngine, AccessForm, AccessRequest, RowAccess } from "./types";

/** Options of {@link createBasicAccessEngine}. */
export interface BasicAccessEngineOptions {
  /**
   * Decides `entry` and `scope` forms. Without it they fail with `INTERNAL`,
   * naming the service, because no access policy is configured.
   */
  readonly rows?: RowAccess;
}

function forbidden(): QuickdrawError {
  return new QuickdrawError("FORBIDDEN", "Insufficient permissions");
}

const NO_ROW_POLICY: RowAccess = {
  allows(form, request) {
    const kind = form.scope === undefined ? "entry" : "scope";
    throw new QuickdrawError(
      "INTERNAL",
      `${request.service.name}.${request.method} uses ${kind} access, but no access policy is configured for ${request.service.name}`,
    );
  },
};

async function decide(form: AccessForm, request: AccessRequest, rows: RowAccess): Promise<void> {
  if (form === "public") {
    return;
  }
  const { principal, service } = request;
  if (principal === null) {
    throw new QuickdrawError("UNAUTHENTICATED", "Authentication required");
  }
  const grant = serviceGrant(principal, service.name);
  if (form === "authenticated" || (service.adminBypass && grant === "Admin")) {
    return;
  }
  if (isCustomAccess(form)) {
    // The check was typed for this method's input and context, which are
    // what the dispatcher passes.
    const check = form.check as (ctx: AnyContext, input: unknown) => MaybePromise<boolean>;
    if ((await check(request.ctx, request.input)) === true) {
      return;
    }
    throw forbidden();
  }
  if (form.service !== undefined && meetsLevel(grant, form.service)) {
    return;
  }
  if (
    (form.entry !== undefined || form.scope !== undefined) &&
    (await rows.allows(form, request)) === true
  ) {
    return;
  }
  throw forbidden();
}

/**
 * The default access engine:
 *
 * - `"public"` always passes.
 * - Every other form needs a principal; without one the call fails with
 *   `UNAUTHENTICATED`.
 * - A service-wide `Admin` grant passes every check on its service, unless
 *   the service sets `adminBypass: false`.
 * - `"authenticated"` passes for any principal.
 * - `custom(fn)` passes when `fn(ctx, input)` resolves `true`.
 * - `{ service: L }` passes when the principal's grant on the service is at
 *   least `L`. A lower grant counts only where `service` is named, so a
 *   `Read` grant does not read every row.
 * - `{ entry }` and `{ scope }` ask `options.rows`; `{ service, entry }`
 *   passes on either.
 *
 * Anything else fails with `FORBIDDEN`.
 */
export function createBasicAccessEngine(options: BasicAccessEngineOptions = {}): AccessEngine {
  const rows = options.rows ?? NO_ROW_POLICY;
  return Object.freeze({
    authorize: (form: AccessForm, request: AccessRequest) => decide(form, request, rows),
  });
}
