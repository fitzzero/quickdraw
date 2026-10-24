// The tickets of a mutation hook's calls (`issuer.ts`): who a call is made
// as, under which credentials epoch, when it may be sent and when the hook
// may show it. Over a connection whose hello the test sets; the epoch rules
// take the epoch as given (the connection's own counter, and whose session
// the server ended, are `connection.test.ts`'s, and the hook's wiring
// `mutation.test.tsx`'s).

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
    subscribe: () => () => undefined,
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

/** A ticket made as `user` under `epoch`; `waiting` while a call made with no hello awaits its own. */
function ticket(user: string | null | undefined, epoch = 0, waiting = false): Ticket {
  return { epoch, user: () => user, waiting: () => waiting, hear: () => undefined };
}

/** The error `run` throws. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("ticketOf", () => {
  it("makes a call issued under a hello the user's it names, anonymous included", () => {
    const issued = ticketOf(helloConnection(fakeHello("ada")).connection);
    expect(issued.user()).toBe("ada");
    expect(issued.waiting()).toBe(false);
    expect(ticketOf(helloConnection(fakeHello(null)).connection).user()).toBeNull();
    expect(issued.epoch).toBe(0);
  });

  it("makes a call issued with no hello the user's the next hello names", () => {
    const { connection, set, listening } = helloConnection(null);
    const issued = ticketOf(connection);
    expect(issued.user()).toBeUndefined();
    expect(issued.waiting()).toBe(true);
    set(fakeHello("ed"));
    expect(issued.user()).toBe("ed");
    expect(issued.waiting()).toBe(false);
    expect(listening()).toBe(0);
    // Later hellos change nothing: the call ran on Ed's socket.
    set(fakeHello("ada"));
    expect(issued.user()).toBe("ed");
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
  });

  it("sends a call nobody's yet under its epoch only until a hello names someone else", () => {
    // Made with no hello: the next one is its own, while it awaits it.
    expect(sendable(ticket(undefined, 0, true), null, 0)).toBe(true);
    expect(sendable(ticket(undefined, 0, true), fakeHello("ed"), 0)).toBe(true);
    // Settled before any hello, or not claimed by the one that came: nobody's to send.
    expect(sendable(ticket(undefined), null, 0)).toBe(true);
    expect(sendable(ticket(undefined), fakeHello("ed"), 0)).toBe(false);
    expect(sendable(ticket(undefined), fakeHello(null), 0)).toBe(false);
  });

  it("sends a call under another epoch only once its hello names the call's user", () => {
    expect(sendable(ticket("ada"), fakeHello("ada"), 1)).toBe(true);
    // New credentials whose user is not known yet.
    expect(sendable(ticket("ada"), null, 1)).toBe(false);
    expect(sendable(ticket("ada"), fakeHello("ed"), 1)).toBe(false);
    // Anonymous, then signed in: the anonymous call is not the user's.
    expect(sendable(ticket(null), fakeHello("ada"), 1)).toBe(false);
    expect(sendable(ticket(undefined, 0, true), null, 1)).toBe(false);
    expect(sendable(ticket(undefined, 0, true), fakeHello("ed"), 1)).toBe(false);
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

  it("shows a call nobody's yet under its epoch while no hello is held, or while it awaits its own", () => {
    expect(shownTo(ticket(undefined), null, 0)).toBe(true);
    expect(shownTo(ticket(undefined, 0, true), fakeHello("ed"), 0)).toBe(true);
    // One that settled before any hello: not for whoever signs in next, a cookie's way included.
    expect(shownTo(ticket(undefined), fakeHello("ed"), 0)).toBe(false);
    expect(shownTo(ticket(undefined), null, 1)).toBe(false);
    expect(shownTo(ticket(undefined, 0, true), fakeHello("ed"), 1)).toBe(false);
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
    expect(tickets.of(input)).toEqual([ada]);
    expect(tickets.of({ text: "a" })).toEqual([]);
    const byValue = tickets.hold("ping", ada);
    expect(tickets.of("ping")).toEqual([ada]);
    release();
    byValue();
    // Let go twice: nothing more goes.
    release();
    expect(tickets.of(input)).toEqual([]);
    expect(tickets.of("ping")).toEqual([]);
  });

  it("keeps every ticket held for one value, oldest first, and lets each go alone", () => {
    const tickets = createTickets();
    const input = { text: "same" };
    const ada = ticket("ada");
    const ed = ticket("ed", 1);
    const first = tickets.hold(input, ada);
    tickets.hold(input, ed);
    expect(tickets.of(input)).toEqual([ada, ed]);
    first();
    expect(tickets.of(input)).toEqual([ed]);
  });
});

describe("checkedTicket", () => {
  /** `tickets` holding `held` for `input`. */
  function holding(input: unknown, ...held: Ticket[]) {
    const tickets = createTickets();
    for (const each of held) {
      tickets.hold(input, each);
    }
    return tickets;
  }

  it("gives the first ticket once every ticket held for the value may be sent", () => {
    const input = { text: "a" };
    const ada = ticket("ada");
    // The same user's call made under other credentials since, sent again once their hello names her.
    const tickets = holding(input, ada, ticket("ada", 1));
    const { connection } = helloConnection(fakeHello("ada"));
    expect(checkedTicket(tickets, input, connection)).toBe(ada);
  });

  it("refuses every call of a value one ticket of which may not be sent, CANCELLED", () => {
    const input = { text: "shared" };
    const { connection } = helloConnection(fakeHello("ed"));
    for (const tickets of [
      holding(input, ticket("ed"), ticket("ada")),
      holding(input, ticket("ada"), ticket("ed")),
    ]) {
      const refusal = thrownBy(() => checkedTicket(tickets, input, connection));
      expect(refusal).toBeInstanceOf(QuickdrawError);
      expect(refusal).toMatchObject({
        code: "CANCELLED",
        message: "The user changed before the call was sent",
      });
      expect(isUserChange(refusal)).toBe(true);
    }
    expect(isUserChange(new QuickdrawError("CANCELLED", "Another cancel"))).toBe(false);
  });

  it("says the user changed only when a hello names someone the call is not made as", () => {
    const input = { text: "a" };
    const refusalOf = (held: Ticket, hello: HelloFrame | null): unknown =>
      thrownBy(() => checkedTicket(holding(input, held), input, helloConnection(hello).connection));
    const credentials = "The credentials changed before the call was sent";
    const user = "The user changed before the call was sent";
    // Made under other credentials, whose user no hello names yet.
    expect(refusalOf(ticket("ada", 1), null)).toMatchObject({
      code: "CANCELLED",
      message: credentials,
    });
    // A call no hello made anyone's, from other credentials: whoever the hello names, they changed.
    expect(refusalOf(ticket(undefined, 1), fakeHello("ada"))).toMatchObject({
      message: credentials,
    });
    // Under its own credentials, a hello names someone who did not make it theirs.
    expect(refusalOf(ticket(undefined, 0), fakeHello("ed"))).toMatchObject({ message: user });
    // Made as Ada, and the hello names Ed: the user changed, whatever the credentials.
    expect(refusalOf(ticket("ada", 1), fakeHello("ed"))).toMatchObject({ message: user });
    expect(refusalOf(ticket("ada", 0), fakeHello("ed"))).toMatchObject({ message: user });
  });

  it("refuses a call it holds no ticket for: nothing says whose it is", () => {
    const refusal = thrownBy(() =>
      checkedTicket(createTickets(), { text: "b" }, helloConnection(null).connection),
    );
    expect(refusal).toMatchObject({
      code: "CANCELLED",
      message: "The call was not sent: nothing says which user made it",
    });
    expect(isUserChange(refusal)).toBe(true);
  });
});
