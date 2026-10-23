// Who a call of a mutation hook runs as (`issuer.ts`), and when the hook
// may show its state: over a connection whose hello the test sets. A call
// issued under a hello runs as the user it names; one issued with none runs
// as the user the next hello names, unless it settles first; and its state
// shows only while the hello names its user, anonymous included.

import { describe, expect, it } from "vitest";
import type { HelloFrame } from "../protocol/version";
import type { QuickdrawConnection } from "./connection";
import { issuerOf, shownTo } from "./issuer";
import { fakeHello } from "./live/__tests__/fakeSocket";

/** A connection holding `hello`, whose next hellos the test gives. */
function helloConnection(hello: HelloFrame | null) {
  let held = hello;
  const listeners = new Set<(next: HelloFrame) => void>();
  const connection = {
    getState: () => ({ hello: held }),
    onHello(listener: (next: HelloFrame) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as QuickdrawConnection;
  return {
    connection,
    listening: (): number => listeners.size,
    /** The connection's hello is now `next`, as a new socket's or new credentials' brings it. */
    set(next: HelloFrame | null): void {
      held = next;
      if (next !== null) {
        for (const listener of [...listeners]) {
          listener(next);
        }
      }
    },
  };
}

describe("issuerOf", () => {
  it("runs a call issued under a hello as the user it names, anonymous included", () => {
    const ada = issuerOf(helloConnection(fakeHello("ada")).connection);
    expect(ada.user()).toBe("ada");
    expect(shownTo(ada, fakeHello("ada"))).toBe(true);
    expect(shownTo(ada, fakeHello("ed"))).toBe(false);
    expect(shownTo(ada, fakeHello(null))).toBe(false);
    expect(shownTo(ada, null)).toBe(false);
    const anonymous = issuerOf(helloConnection(fakeHello(null)).connection);
    expect(anonymous.user()).toBeNull();
    expect(shownTo(anonymous, fakeHello(null))).toBe(true);
    expect(shownTo(anonymous, fakeHello("ada"))).toBe(false);
  });

  it("never shows another user a call that settles after their hello", () => {
    const { connection, set } = helloConnection(fakeHello("ada"));
    const issuer = issuerOf(connection);
    set(null);
    set(fakeHello("ed"));
    issuer.settled();
    expect(issuer.user()).toBe("ada");
    expect(shownTo(issuer, fakeHello("ed"))).toBe(false);
  });

  it("runs a call issued with no hello as the user the next hello names", () => {
    const { connection, set, listening } = helloConnection(null);
    const issuer = issuerOf(connection);
    expect(issuer.user()).toBeUndefined();
    expect(shownTo(issuer, fakeHello("ed"))).toBe(false);
    set(fakeHello("ed"));
    expect(issuer.user()).toBe("ed");
    expect(listening()).toBe(0);
    // Later hellos change nothing: the call ran on Ed's socket.
    set(fakeHello("ada"));
    expect(issuer.user()).toBe("ed");
    expect(shownTo(issuer, fakeHello("ed"))).toBe(true);
    expect(shownTo(issuer, fakeHello("ada"))).toBe(false);
  });

  it("shows a call issued with no hello that settled before one to nobody", () => {
    const { connection, set, listening } = helloConnection(null);
    const issuer = issuerOf(connection);
    issuer.settled();
    expect(listening()).toBe(0);
    set(fakeHello("ed"));
    expect(issuer.user()).toBeUndefined();
    expect(shownTo(issuer, fakeHello("ed"))).toBe(false);
  });

  it("hides nothing before any call is issued", () => {
    expect(shownTo(undefined, null)).toBe(true);
    expect(shownTo(undefined, fakeHello("ed"))).toBe(true);
  });
});
