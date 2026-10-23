// The user a call of a mutation hook runs as, and whether the hook may show
// its state now (RFC 0003 sections 6, 11.2 and 11.4). A mutation's result,
// error and input (`variables`) belong to the user it ran as: the result
// holds fields at that user's access tier, and the input is what that user
// sent. A mounted mutation hook outlives a switch of users (new
// credentials, or a session the server ended and the next sign-in), and
// TanStack keeps its observer's state across it, outside the cache the
// session empties (`cacheSession.ts`). So the hook records who each call of
// it runs as when it is issued, and shows the state only while the
// connection's hello names that user (`mutation.ts`):
//
// - issued while a hello is held, a call runs as the user it names
//   (`userOf`: `null`, anonymous, counts as a user);
// - issued while none is (before the first hello, while new credentials
//   await theirs), its call waits for the next socket and runs as the user
//   that socket's hello names, unless it settles first (new credentials
//   again, a refused session, no connection at all): it then ran as nobody,
//   and its state is never shown.
//
// A reconnect with the same credentials keeps the hello (C13a), so a
// finished call's state stays shown through it; new credentials hide it
// until their hello, which shows it again if it names the same user.
//
// React-free.

import type { HelloFrame } from "../protocol/version";
import { userOf } from "./cacheSession";
import type { QuickdrawConnection } from "./connection";

/** Who one call of a mutation hook runs as. */
export interface Issuer {
  /** The user it runs as (`null`: anonymous); `undefined` while none is known, and for good if it settled before a hello. */
  user(): string | null | undefined;
  /** The call settled: if no hello named its user yet, none will. */
  settled(): void;
}

/** The issuer of a call made on `connection` now. */
export function issuerOf(connection: QuickdrawConnection): Issuer {
  const { hello } = connection.getState();
  if (hello !== null) {
    const userId = userOf(hello);
    return Object.freeze({ user: () => userId, settled: () => undefined });
  }
  // No hello: the call waits for the next socket, and runs as the user its hello names.
  let userId: string | null | undefined;
  let waiting = true;
  const stop = connection.onHello((next) => {
    if (waiting) {
      waiting = false;
      userId = userOf(next);
      stop();
    }
  });
  return Object.freeze({
    user: () => userId,
    settled(): void {
      if (waiting) {
        waiting = false;
        stop();
      }
    },
  });
}

/**
 * True when a mutation hook may show the state of the call `issuer` ran:
 * while `hello` names that call's user. With no call issued yet, there is
 * nothing to hide.
 */
export function shownTo(issuer: Issuer | undefined, hello: HelloFrame | null): boolean {
  if (issuer === undefined) {
    return true;
  }
  const userId = issuer.user();
  return userId !== undefined && hello !== null && userOf(hello) === userId;
}
