// The row access the policy engine gives the basic engine: `{ entry: L }`
// asks the service's own policy, `{ scope: L, of }` the policy of `of`'s
// service, about every id the form names, in one batched lookup. The basic
// engine has already let `"public"` through, answered `UNAUTHENTICATED` for
// an anonymous caller, applied the service-wide `Admin` bypass and the
// `service` half of a combined form; a `false` here becomes `FORBIDDEN`.

import { QuickdrawError } from "../../protocol/errors";
import { accessIds } from "./forms";
import { meetsLevel } from "./levels";
import { startCall, type EngineState } from "./tools";
import type { RowAccess } from "./types";

/** Decides `entry` and `scope` forms from the bound policies. */
export function createRowAccess(state: EngineState): RowAccess {
  return Object.freeze({
    async allows(form, request) {
      const asks = form.scope === undefined ? request.service.name : form.of.name;
      const binding = state.bindings.get(asks);
      if (binding === undefined) {
        const kind = form.scope === undefined ? "entry" : "scope";
        throw new QuickdrawError(
          "INTERNAL",
          `${request.service.name}.${request.method} uses ${kind} access, but no access policy is configured for ${asks}`,
        );
      }
      const { principal } = request;
      // Policies compare user ids: a principal without one has no level anywhere.
      if (principal === null || typeof principal.userId !== "string" || principal.userId === "") {
        return false;
      }
      // A missing or empty id is FORBIDDEN: a failed lookup denies.
      const ids = accessIds(form, request.input);
      const required = form.scope === undefined ? form.entry : form.scope;
      const levels = await startCall(state).levels(binding, principal, ids);
      return ids.every((id) => meetsLevel(levels.get(id), required));
    },
  } satisfies RowAccess);
}
