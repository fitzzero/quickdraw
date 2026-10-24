// Who a call of a mutation hook runs as, when it may be sent, and when the
// hook may show it (RFC 0003 sections 6, 11.2 and 11.4). Each call carries a
// ticket from the moment it is issued: the user it is made as, and the
// credentials epoch it is made under (`credentialsEpochOf`). The ticket
// rides beside the call, never in its `variables`: the hook keeps it by the
// call's variables (`Tickets`).
//
// - Issued while a hello is held, a call is the user's that hello names
//   (`userOf`: `null`, anonymous, counts as a user). Issued while none is
//   (before the first hello, while new credentials await theirs, after the
//   server ended the session), its call waits for the next socket, so it is
//   the user's whom the next hello under the same epoch names; one that
//   settles first, or whose epoch changes first, is nobody's.
// - Sent: TanStack runs a mutation's function late (after `onMutate`, a
//   pause while offline, a `scope` queue) and again for each retry, and a
//   call goes out on whatever socket the connection holds then, as whoever
//   that socket's credentials name. So every attempt is checked first
//   (`checkedTicket`): under the epoch it was made under, it is sent unless a
//   hello names another user than its own (credentials that now name someone
//   else, as a cookie might); under another epoch, only once that epoch's
//   hello names its own user (the same user's new token). Otherwise it fails
//   `CANCELLED`, never sent, and is not retried.
// - Shown (`shownTo`): a call made as a user, only while a hello names that
//   user (the next user sees none of it, nor anyone while new credentials
//   await their hello; the same user sees it again, and through a
//   reconnect); a call made with no hello, to whoever views it under the
//   epoch it was made under, pending and then its answer or error.
//
// React-free.

import { QuickdrawError } from "../protocol/errors";
import type { HelloFrame } from "../protocol/version";
import { userOf } from "./cacheSession";
import { credentialsEpochOf, type QuickdrawConnection } from "./connection";

/** Who one call of a mutation hook is made as, and under which credentials. */
export interface Ticket {
  /** The credentials epoch it was issued under (`credentialsEpochOf`). */
  readonly epoch: number;
  /** The user it is made as (`null`: anonymous); `undefined` while none is known, and for good if none will be. */
  user(): string | null | undefined;
  /** The call settled: if no hello named its user yet, none will. */
  settled(): void;
}

/** The ticket of a call issued on `connection` now. */
export function ticketOf(connection: QuickdrawConnection): Ticket {
  const epoch = credentialsEpochOf(connection);
  const { hello } = connection.getState();
  if (hello !== null) {
    const userId = userOf(hello);
    return Object.freeze({ epoch, user: () => userId, settled: () => undefined });
  }
  // No hello: the call waits for the next socket, and is the user's its hello names.
  let userId: string | null | undefined;
  let waiting = true;
  const stop = connection.onHello((next) => {
    if (waiting) {
      waiting = false;
      // Other credentials since: whoever this hello names, the call was not made as them.
      if (credentialsEpochOf(connection) === epoch) {
        userId = userOf(next);
      }
      stop();
    }
  });
  return Object.freeze({
    epoch,
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
 * True when a call made with `ticket` may be sent now, while the connection
 * holds `hello` under credentials epoch `epoch`.
 */
export function sendable(ticket: Ticket, hello: HelloFrame | null, epoch: number): boolean {
  const user = ticket.user();
  // Whether the hello names the call's user: undefined while either is unknown.
  const same = hello === null || user === undefined ? undefined : userOf(hello) === user;
  if (epoch === ticket.epoch) {
    // The credentials it was made under, unless they name another user now.
    return same !== false;
  }
  // Other credentials since: only their hello naming its user may send it.
  return same === true;
}

/** The refusals `checkedTicket` made, which no retry sends. */
const refusals = new WeakSet<QuickdrawError>();

/** True for the refusal of a call whose user changed before it was sent (`checkedTicket`). */
export function isUserChange(error: unknown): boolean {
  return error instanceof QuickdrawError && refusals.has(error);
}

/**
 * The ticket of the call made with `variables`, when it may be sent on
 * `connection` now; else throws the call's refusal: `CANCELLED`, as for a
 * call new credentials found waiting to be sent. A call with no ticket (made
 * outside the hook, or one of several calls of one `variables` value whose
 * tickets disagree) is refused too: nothing says whose it is.
 */
export function checkedTicket(
  tickets: Tickets,
  variables: unknown,
  connection: QuickdrawConnection,
): Ticket {
  const ticket = tickets.of(variables);
  const { hello } = connection.getState();
  if (ticket !== undefined && sendable(ticket, hello, credentialsEpochOf(connection))) {
    return ticket;
  }
  const refusal = new QuickdrawError("CANCELLED", "The user changed before the call was sent");
  refusals.add(refusal);
  throw refusal;
}

/**
 * True when a mutation hook may show the state of the call `ticket` was
 * issued for, while the connection holds `hello` under credentials epoch
 * `epoch`. With no call issued yet, there is nothing to hide.
 */
export function shownTo(
  ticket: Ticket | undefined,
  hello: HelloFrame | null,
  epoch: number,
): boolean {
  if (ticket === undefined) {
    return true;
  }
  const user = ticket.user();
  if (user === undefined) {
    // Made with no hello: to whoever views it under the credentials it was made under.
    return epoch === ticket.epoch;
  }
  return hello !== null && userOf(hello) === user;
}

/** `shownTo` for the state `connection` holds now. */
export function shownOn(ticket: Ticket | undefined, connection: QuickdrawConnection): boolean {
  return shownTo(ticket, connection.getState().hello, credentialsEpochOf(connection));
}

/** The tickets of a hook's calls on their way, by their `variables` (that very value). */
export interface Tickets {
  /** Keeps `ticket` for a call made with `variables`; returns the function that lets it go. */
  hold(variables: unknown, ticket: Ticket): () => void;
  /** The ticket of the call made with `variables`; `undefined` for none, or tickets that disagree. */
  of(variables: unknown): Ticket | undefined;
}

/** The tickets of one hook's calls. */
export function createTickets(): Tickets {
  // By reference for an object, by value otherwise, as TanStack hands the variables back.
  const byObject = new WeakMap<object, Ticket[]>();
  const byValue = new Map<unknown, Ticket[]>();
  const isObject = (variables: unknown): variables is object =>
    (typeof variables === "object" && variables !== null) || typeof variables === "function";
  const heldFor = (variables: unknown): Ticket[] | undefined =>
    isObject(variables) ? byObject.get(variables) : byValue.get(variables);
  const keep = (variables: unknown, held: Ticket[]): void => {
    if (isObject(variables)) {
      byObject.set(variables, held);
    } else if (held.length === 0) {
      byValue.delete(variables);
    } else {
      byValue.set(variables, held);
    }
  };
  return Object.freeze({
    hold(variables: unknown, ticket: Ticket): () => void {
      keep(variables, [...(heldFor(variables) ?? []), ticket]);
      let held = true;
      return () => {
        if (held) {
          held = false;
          const tickets = [...(heldFor(variables) ?? [])];
          const index = tickets.indexOf(ticket);
          if (index >= 0) {
            tickets.splice(index, 1);
          }
          keep(variables, tickets);
        }
      };
    },
    of(variables: unknown): Ticket | undefined {
      const [first, ...others] = heldFor(variables) ?? [];
      const agree = others.every(
        (other) => other.epoch === first?.epoch && other.user() === first.user(),
      );
      return agree ? first : undefined;
    },
  });
}
