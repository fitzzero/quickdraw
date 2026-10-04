// The checks a sharing change makes inside its transaction (RFC 0003
// sections 4 and 12.3): its caller, here, and whether the row keeps an Admin
// (`admins.ts`, re-exported here). The pipeline authorized the call before
// the transaction opened; a concurrent change (another Admin unsharing them)
// may have lowered the caller's level since. So each change reads the
// caller's own level on the row again as its first statement inside the
// SERIALIZABLE transaction (the access engine's reads go through the
// transaction's client there, and skip the cross-request cache), and:
//
// - refuses the change (`FORBIDDEN`) when that level no longer meets the
//   row-level half of the method's form (`{ entry: L }`; a `{ service: L }`
//   half passes on the caller's grant, which no row holds, and a form
//   without a row level, `"authenticated"` say, is not checked again);
// - caps what the change gives: a caller never shares, sets or invites at a
//   level above their own on the row (`FORBIDDEN`), so a form lowered to
//   `{ entry: "Moderate" }` cannot hand out `Admin`.
//
// The caller's own level is the policy's (a service-wide `Admin` grant with
// `adminBypass` gives `Admin`), or their service-wide grant when the form
// names `service` and the grant is higher: a grant counts where the form
// names it (RFC 0003 section 4.1).

import type { AccessLevel } from "../../../contract/access";
import { QuickdrawError } from "../../../protocol/errors";
import { isCustomAccess } from "../../access/forms";
import { maxLevel, meetsLevel, serviceGrant } from "../../access/levels";
import type { AccessForm } from "../../access/types";
import type { SharingCall } from "./runtime";

export { adminElsewhere } from "./admins";

/** The levels of an object form's halves: its `service` and `entry` levels, when it names them. */
function halvesOf(form: AccessForm): { service?: AccessLevel; entry?: AccessLevel } {
  return typeof form === "object" && !isCustomAccess(form)
    ? { service: form.service, entry: form.entry }
    : {};
}

/**
 * Reads the caller's own level on row `id` (call it inside the change's
 * transaction) and refuses the change unless it still meets the form's
 * row-level half; resolves with that level, to cap what the change gives.
 */
export async function checkCaller(
  call: SharingCall,
  form: AccessForm,
  id: string,
): Promise<AccessLevel | null> {
  const { principal, runtime } = call;
  if (principal === null) {
    throw new QuickdrawError("UNAUTHENTICATED", "Authentication required");
  }
  const levels = await runtime.access.levelsFor(runtime.service.name, principal, [id]);
  const policy = levels.get(id) ?? null;
  const halves = halvesOf(form);
  const grant = serviceGrant(principal, runtime.service.name) ?? null;
  const granted = halves.service !== undefined && meetsLevel(grant, halves.service);
  if (halves.entry !== undefined && !granted && !meetsLevel(policy, halves.entry)) {
    throw new QuickdrawError(
      "FORBIDDEN",
      `Your access to this ${call.model} changed while the change ran; you no longer have ${halves.entry} on it`,
    );
  }
  return halves.service === undefined ? policy : maxLevel(policy, grant);
}

/** `FORBIDDEN` when a change would give `given` above the caller's own level on the row. */
export function capGrant(own: AccessLevel | null, given: AccessLevel | null, model: string): void {
  if (given !== null && !meetsLevel(own, given)) {
    throw new QuickdrawError(
      "FORBIDDEN",
      `You cannot give ${given} on this ${model}: it is above your own level on it (${own ?? "none"})`,
    );
  }
}
