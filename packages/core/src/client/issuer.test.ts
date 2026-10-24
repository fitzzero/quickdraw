// The tickets of a mutation hook's calls (`issuer.ts`): who a call is made
// as, under which credentials epoch, when it may be sent and when the hook
// may show it. Over a connection whose hello the test sets; the epoch rules
// take the epoch as given (the connection's own counter is
// `connection.test.ts`'s, and the hook's wiring `mutation.test.tsx`'s).

import { describe, expect, it } from "vitest";
import { QuickdrawError } from "../protocol/errors";
import type { HelloFrame } from "../protocol/version";
import type { QuickdrawConnection } from "./connection";
import {
  checkedTicket,
  createTickets,
  isUserChange,
  sendable,
  shownTo,
  ticketOf,
  type Ticket,
} from "./issuer";
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

/** A ticket made as `user` under `epoch`. */
function ticket(user: string | null | undefined, epoch = 0): Ticket {
  return { epoch, user: () => user, settled: () => undefined };
}

describe("ticketOf", () => {
  it("makes a call issued under a hello the user's it names, anonymous included", () => {
    expect(ticketOf(helloConnection(fakeHello("ada")).connection).user()).toBe("ada");
    expect(ticketOf(helloConnection(fakeHello(null)).connection).user()).toBeNull();
    expect(ticketOf(helloConnection(fakeHello("ada")).connection).epoch).toBe(0);
  });

  it("makes a call issued with no hello the user's the next hello names", () => {
    const { connection, set, listening } = helloConnection(null);
    const issued = ticketOf(connection);
    expect(issued.user()).toBeUndefined();
    set(fakeHello("ed"));
    expect(issued.user()).toBe("ed");
    expect(listening()).toBe(0);
    // Later hellos change nothing: the call ran on Ed's socket.
    set(fakeHello("ada"));
    expect(issued.user()).toBe("ed");
  });

  it("makes a call issued with no hello that settled before one nobody's", () => {
    const { connection, set, listening } = helloConnection(null);
    const issued = ticketOf(connection);
    issued.settled();
    expect(listening()).toBe(0);
    set(fakeHello("ed"));
    expect(issued.user()).toBeUndefined();
  });
});

describe("sendable", () => {
  it("sends a call under its epoch unless a hello names another user", () => {
    expect(sendable(ticket("ada"), fakeHello("ada"), 0)).toBe(true);
    // Waiting for its socket to come back, under the same credentials.
    expect(sendable(ticket("ada"), null, 0)).toBe(true);
    // The same credentials name another user now (a cookie that changed).
    expect(sendable(ticket("ada"), fakeHello("ed"), 0)).toBe(false);
    expect(sendable(ticket("ada"), fakeHello(null), 0)).toBe(false);
    expect(sendable(ticket(null), fakeHello(null), 0)).toBe(true);
    // Made with no hello: the next one is its own.
    expect(sendable(ticket(undefined), null, 0)).toBe(true);
    expect(sendable(ticket(undefined), fakeHello("ed"), 0)).toBe(true);
  });

  it("sends a call under another epoch only once its hello names the call's user", () => {
    expect(sendable(ticket("ada"), fakeHello("ada"), 1)).toBe(true);
    // New credentials whose user is not known yet.
    expect(sendable(ticket("ada"), null, 1)).toBe(false);
    expect(sendable(ticket("ada"), fakeHello("ed"), 1)).toBe(false);
    // Anonymous, then signed in: the anonymous call is not the user's.
    expect(sendable(ticket(null), fakeHello("ada"), 1)).toBe(false);
    expect(sendable(ticket(undefined), null, 1)).toBe(false);
    expect(sendable(ticket(undefined), fakeHello("ed"), 1)).toBe(false);
  });
});

describe("shownTo", () => {
  it("shows a call made as a user only while a hello names them, whatever the epoch", () => {
    expect(shownTo(ticket("ada"), fakeHello("ada"), 0)).toBe(true);
    expect(shownTo(ticket("ada"), fakeHello("ada"), 3)).toBe(true);
    expect(shownTo(ticket("ada"), fakeHello("ed"), 0)).toBe(false);
    expect(shownTo(ticket("ada"), fakeHello(null), 0)).toBe(false);
    expect(shownTo(ticket("ada"), null, 0)).toBe(false);
    expect(shownTo(ticket(null), fakeHello(null), 0)).toBe(true);
  });

  it("shows a call made with no hello to whoever views it under its epoch", () => {
    expect(shownTo(ticket(undefined), null, 0)).toBe(true);
    expect(shownTo(ticket(undefined), fakeHello("ed"), 0)).toBe(true);
    expect(shownTo(ticket(undefined), null, 1)).toBe(false);
    expect(shownTo(ticket(undefined), fakeHello("ed"), 1)).toBe(false);
  });

  it("hides nothing before any call is issued", () => {
    expect(shownTo(undefined, null, 0)).toBe(true);
    expect(shownTo(undefined, fakeHello("ed"), 2)).toBe(true);
  });
});

describe("createTickets", () => {
  it("keeps a ticket by its variables until it is let go: an object by reference, a value by value", () => {
    const tickets = createTickets();
    const input = { text: "a" };
    const ada = ticket("ada");
    const release = tickets.hold(input, ada);
    expect(tickets.of(input)).toBe(ada);
    expect(tickets.of({ text: "a" })).toBeUndefined();
    const byValue = tickets.hold("ping", ada);
    expect(tickets.of("ping")).toBe(ada);
    release();
    byValue();
    expect(tickets.of(input)).toBeUndefined();
    expect(tickets.of("ping")).toBeUndefined();
  });

  it("gives no ticket for one variables value held by tickets that disagree", () => {
    const tickets = createTickets();
    const input = { text: "same" };
    const ada = ticket("ada");
    tickets.hold(input, ada);
    tickets.hold(input, ticket("ada"));
    expect(tickets.of(input)).toBe(ada);
    const release = tickets.hold(input, ticket("ed", 1));
    expect(tickets.of(input)).toBeUndefined();
    release();
    expect(tickets.of(input)).toBe(ada);
  });
});

describe("checkedTicket", () => {
  it("gives the ticket of a call it may send, and refuses one whose user changed, CANCELLED", () => {
    const tickets = createTickets();
    const input = { text: "a" };
    tickets.hold(input, ticket("ada"));
    expect(checkedTicket(tickets, input, helloConnection(fakeHello("ada")).connection).user()).toBe(
      "ada",
    );
    let refusal: unknown;
    try {
      checkedTicket(tickets, input, helloConnection(fakeHello("ed")).connection);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(QuickdrawError);
    expect(refusal).toMatchObject({ code: "CANCELLED" });
    expect(isUserChange(refusal)).toBe(true);
    expect(isUserChange(new QuickdrawError("CANCELLED", "Another cancel"))).toBe(false);
    // No ticket: nothing says whose the call is.
    expect(() => checkedTicket(tickets, { text: "b" }, helloConnection(null).connection)).toThrow(
      "The user changed before the call was sent",
    );
  });
});
