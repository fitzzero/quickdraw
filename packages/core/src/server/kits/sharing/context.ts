// What every sharing kit handler is made from: the hooks `sharing.handlers`
// was given, and its method's access form. And the user a by-name method means (`shareByName`,
// `inviteByName`): the app's `resolveUser` finds them by the `name` or
// `email` the call gave, before the change's transaction opens; no such user
// is `NOT_FOUND`.

import { QuickdrawError } from "../../../protocol/errors";
import type { AccessForm } from "../../access/types";
import { checked } from "../../devWarnings";
import type { SharingCall } from "./runtime";
import type { SharingOnChange, SharingResolveUser, SharingUserLookup } from "./types";

/** The hooks a sharing kit handler calls, and the form its method runs under. */
export interface HandlerContext {
  readonly resolveUser: SharingResolveUser | undefined;
  readonly onChange: SharingOnChange | undefined;
  /** The method's access form: a change checks its caller against it again (`checks.ts`). */
  readonly form: AccessForm;
}

/** What a by-name call gave: a name, an email, or both. */
interface GivenLookup {
  readonly name: string | undefined;
  readonly email: string | undefined;
}

/** The user id `resolveUser` finds for the call's `name` or `email`; `NOT_FOUND` when it finds none. */
export async function resolveTarget(
  call: SharingCall,
  context: HandlerContext,
  given: GivenLookup,
): Promise<string> {
  if (context.resolveUser === undefined) {
    throw new QuickdrawError(
      "INTERNAL",
      "The sharing kit's by-name methods need sharing.handlers' resolveUser",
    );
  }
  const lookup: SharingUserLookup = Object.freeze({
    ...(given.name === undefined ? {} : { name: given.name }),
    ...(given.email === undefined ? {} : { email: given.email }),
  });
  const { resolveUser } = context;
  const found: unknown = await checked(() => resolveUser(lookup, call.ctx, call.db));
  if (found === null || found === undefined) {
    throw new QuickdrawError("NOT_FOUND", "No such user");
  }
  if (typeof found !== "string" || found.length === 0) {
    throw new QuickdrawError(
      "INTERNAL",
      "sharing.handlers' resolveUser must return a user id, or null when there is no such user",
    );
  }
  return found;
}
