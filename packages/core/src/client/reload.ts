// What a client does by default when the server speaks another protocol
// (RFC 0003 section 8.1): reload the page once per browser session, so a tab
// left open across a deploy picks up the client that matches the server. A
// second mismatch in the same session (the new bundle still speaks the old
// protocol) does not reload again, which would loop.
//
// Without a DOM (React Native, Node) there is nothing to reload and this does
// nothing; such apps pass their own `onProtocolMismatch`. Without
// `sessionStorage` it does nothing either, since it could not stop a loop.

import type { ProtocolMismatch } from "../protocol/version";

/** The `sessionStorage` key that records a reload for one server protocol. */
export const RELOAD_KEY_PREFIX = "quickdraw:protocol-reload:";

interface BrowserScope {
  readonly location?: { reload?: unknown };
  readonly sessionStorage?: Pick<Storage, "getItem" | "setItem">;
}

/** Records the reload in `sessionStorage`; false when one was recorded already or storage fails. */
function firstReload(scope: BrowserScope, key: string): boolean {
  try {
    const storage = scope.sessionStorage;
    if (storage === undefined || storage.getItem(key) !== null) {
      return false;
    }
    storage.setItem(key, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

/** The default `onProtocolMismatch`: reloads the page once per session and server protocol. */
export function reloadOncePerSession(mismatch: ProtocolMismatch): void {
  const scope = globalThis as BrowserScope;
  const location = scope.location;
  if (typeof location?.reload !== "function") {
    return;
  }
  if (firstReload(scope, `${RELOAD_KEY_PREFIX}${mismatch.expected}`)) {
    (location as { reload(): void }).reload();
  }
}
