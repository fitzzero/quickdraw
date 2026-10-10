// Declared principal kinds (RFC 0003 section 4.1): which kinds of principal
// (`principal.kind`: a user, an agent's token, a runner) may call a
// service's methods and subscribe to its live data. `kinds` sits beside
// `access`, never inside a form, at three levels that only narrow:
// `initQuickdraw({ kinds })` for every service the instance defines,
// `defineService(contract, { kinds })` within it, and a method's `kinds`
// within its service's. A level that declares none takes the list above it;
// `undefined` all the way up admits every kind.
//
// The check runs before the access form and outside the access engine, so an
// app's own engine (which sees only the form) cannot skip it, and neither can
// a service-wide `Admin` grant: a token of the wrong kind acting with
// someone's Admin is exactly what it stops. A principal without a kind, or of
// a kind the list does not name, gets `FORBIDDEN`. An anonymous caller
// passes, and the form decides, as it always did (`UNAUTHENTICATED` where it
// needs a principal); that is why a `"public"` method may not declare kinds
// of its own: a caller of a refused kind would call it signed out.
//
// Calls check their method's list in the pipeline, whatever the transport.
// `qd:sub`, `qd:col:sub`, `qd:watch` and `qd:stream:sub` check their
// service's list, and a channel drops the message of a socket of another
// kind, against a set made when the service is defined. A socket's kind is
// set at its handshake and grant pushes keep it, so nothing is ever revoked
// for a kind.

import { QuickdrawError } from "../../protocol/errors";
import type { Principal } from "../types";

type Fail = (message: string) => never;

/** What a `kinds` option narrows: the kinds the level above admits, and who that is, for messages. */
export interface KindsAbove {
  /** `undefined` when the level above admits every kind. */
  readonly kinds: readonly string[] | undefined;
  /** Who admits them, as a message names it: `"initQuickdraw"`, `"its service"`. */
  readonly by: string;
}

function isKindList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((kind) => typeof kind === "string" && kind.length > 0)
  );
}

/**
 * A level's `kinds` option, checked and resolved: a non-empty list of kind
 * names within the kinds `above` admits, each kind once and frozen; what
 * `above` admits when the level declares none. Anything else fails.
 */
export function narrowKinds(
  value: unknown,
  above: KindsAbove | undefined,
  fail: Fail,
): readonly string[] | undefined {
  if (value === undefined) {
    return above?.kinds;
  }
  if (!isKindList(value)) {
    fail(
      'kinds must be a non-empty list of principal kinds (strings), such as ["user"]; leave it out to admit every kind',
    );
  }
  if (above?.kinds !== undefined) {
    const { kinds, by } = above;
    const wider = value.find((kind) => !kinds.includes(kind));
    if (wider !== undefined) {
      fail(
        `kinds may only narrow the kinds ${by} admits (${kinds.join(", ")}), and "${wider}" is not one of them`,
      );
    }
  }
  return Object.freeze([...new Set(value)]);
}

/**
 * Refuses `principal` with `FORBIDDEN` unless `kinds` admits it: its kind is
 * one of them, or `kinds` is `undefined`. An anonymous caller (`null`)
 * passes, so the access form decides. `what` names the method
 * (`tokenService.mint`) or the service in the message.
 */
export function checkKind(
  kinds: readonly string[] | undefined,
  principal: Principal | null,
  what: string,
): void {
  if (kinds === undefined || principal === null) {
    return;
  }
  const { kind } = principal;
  if (typeof kind === "string" && kinds.includes(kind)) {
    return;
  }
  throw new QuickdrawError(
    "FORBIDDEN",
    kind === undefined
      ? `${what} is not open to a principal without a kind`
      : `${what} is not open to principals of kind "${String(kind)}"`,
  );
}
