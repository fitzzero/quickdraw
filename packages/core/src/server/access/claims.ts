// A method's `claims` (RFC 0003 section 4.1): a requirement on the caller's
// verified claims (`principal.claims`, a token's `scope`), declared beside
// `access`, never inside a form. It adds to the form: `{ entry: "Moderate" }`
// with `claims: (claims) => claims?.scope === "triage"` needs Moderate on the
// row and a triage token.
//
// It exists because a claim check written as a `custom` form replaced the
// row check, so any token holding the claim reached every tenant's rows
// (ACCESS-1), and a service-wide `Admin` grant skipped the check, so a
// narrowed token of an Admin user was not narrowed (ACCESS-4). Like `kinds`
// (`kinds.ts`), the check runs in the pipeline right after the method's
// kinds and outside the access engine, so neither an app's own engine (which
// sees only the form) nor any grant passes it.
//
// Without a principal the call is `UNAUTHENTICATED`; when the check returns
// anything but `true`, `FORBIDDEN`. It is synchronous: an `async` function
// is refused when the service is defined, and a check that returns a
// promise anyway (through a cast) fails the call with `INTERNAL`, its
// promise caught so a rejection cannot go unhandled. A check that throws
// fails the call with `INTERNAL` too, closed. A `"public"` method takes
// none, since an anonymous caller, whom `"public"` admits, has no claims.

import { QuickdrawError } from "../../protocol/errors";
import type { Principal } from "../types";
import { checkKind } from "./kinds";
import type { ClaimsCheck } from "./types";

export type { ClaimsCheck };

type Fail = (message: string) => never;

/**
 * A method's `claims` option, checked: a function, on a method whose form
 * needs a principal; `undefined` when it declares none. `owner` names the
 * method in messages (`method "triage"`).
 */
export function claimsOption(
  owner: string,
  entry: Readonly<Record<string, unknown>>,
  fail: Fail,
): ClaimsCheck | undefined {
  const { claims } = entry;
  if (claims === undefined) {
    return undefined;
  }
  if (typeof claims !== "function") {
    fail(
      `${owner}: claims must be a function of (claims, input) that returns true when the caller's claims allow the call`,
    );
  }
  if (claims.constructor.name === "AsyncFunction") {
    fail(
      `${owner}: claims must be synchronous: it decides from the caller's verified claims and the input alone, so it returns true or false, never a promise`,
    );
  }
  if (entry.access === "public") {
    fail(
      `${owner} is "public", so claims cannot hold: an anonymous caller, whom "public" admits, has no claims. Leave claims out, or give it a form that needs a principal`,
    );
  }
  return claims as ClaimsCheck;
}

/**
 * Refuses the call unless `check` admits the principal's claims for `input`:
 * `UNAUTHENTICATED` without a principal, `FORBIDDEN` when the check returns
 * anything but `true`. No check, nothing to refuse. `what` names the method
 * (`taskService.triage`) in the message.
 */
export function checkClaims(
  check: ClaimsCheck | undefined,
  principal: Principal | null,
  input: unknown,
  what: string,
): void {
  if (check === undefined) {
    return;
  }
  if (principal === null) {
    throw new QuickdrawError("UNAUTHENTICATED", "Authentication required");
  }
  const allowed: unknown = check(principal.claims, input);
  if (isThenable(allowed)) {
    // A cast past the types: refused, and its rejection observed.
    Promise.resolve(allowed).catch(() => undefined);
    throw new QuickdrawError(
      "INTERNAL",
      `${what}: claims returned a promise; it must be synchronous`,
    );
  }
  if (allowed !== true) {
    throw new QuickdrawError("FORBIDDEN", `${what} is not open to the caller's claims`);
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { readonly then?: unknown }).then === "function"
  );
}

/**
 * The checks on the caller that run outside the access engine, before the
 * form is asked: the method's `kinds` (`kinds.ts`), then its `claims`.
 */
export function checkKindAndClaims(
  method: {
    readonly kinds: readonly string[] | undefined;
    readonly claims: ClaimsCheck | undefined;
  },
  principal: Principal | null,
  input: unknown,
  what: string,
): void {
  checkKind(method.kinds, principal, what);
  checkClaims(method.claims, principal, input, what);
}
