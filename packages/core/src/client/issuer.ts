// Who a call runs as, when it may be sent, and when a mutation hook may show
// it (RFC 0003 sections 6, 8.2, 11.2 and 11.4). Each call carries a ticket
// from the moment it is issued: the user it is made as, and the credentials
// epoch it is made under (`credentialsEpochOf`). The ticket rides beside the
// call, never in its `variables`: a mutation hook keeps it by the call's
// variables (`Tickets`), and every `call()` makes one of its own when it is
// made, for its socket's hello to check (`refusalAt`).
//
// - Issued while a hello is held, a call is the user's that hello names
//   (`userOf`: `null`, anonymous, counts as a user). Issued while none is
//   (before the first hello, while new credentials await theirs, after the
//   server ended the session), its call waits for the next socket, so it is
//   the user's whom the next hello under the same epoch names: after a
//   session the server ended, only if that hello names the user whose
//   session it was (`endedSessionOf`), signed in again as a cookie would.
//   It stays so if it settles first (a refused item's `retry()` then sends
//   it as that user). One whose epoch changes first, or whose next hello
//   names another user than the ended session's, is nobody's.
// - Sent: TanStack runs a mutation's function late (after `onMutate`, a
//   pause while offline, a `scope` queue) and again for each retry, and a
//   call goes out on whatever socket the connection holds then, as whoever
//   that socket's credentials name. So every attempt is checked first
//   (`checkedTicket`), against every ticket held for its variables: a call
//   made as a user is sent, under the epoch it was made under, unless a
//   hello names another user (credentials that now name someone else, as a
//   cookie might), and under another epoch only once that epoch's hello
//   names its own user (the same user's new token); a call nobody's yet is
//   sent under its epoch while no hello is held, or while it awaits the one
//   that names its user. Otherwise it fails `CANCELLED`, never sent, before
//   its optimistic update runs, and is not retried.
// - Shown (`shownTo`): a call made as a user, only while a hello names that
//   user (the next user sees none of it, nor anyone while new credentials
//   await their hello; the same user sees it again, and through a
//   reconnect); a call nobody's yet, to whoever views it under its epoch
//   while no hello is held, or while it awaits its hello.
// - On the socket: the hook's check runs against the hello the connection
//   holds, which a drop keeps, while a reconnect's socket may speak for
//   someone else (a cookie). So `call()` holds every call made while its
//   socket has no hello of its own, from a connect or a drop until that
//   hello (`socket.ts`), which each held call's ticket hears first: it goes
//   out if that hello names its user, by the same rules, and is refused
//   `CANCELLED` otherwise (`refusalAt`).
//
// React-free.

import { QuickdrawError } from "../protocol/errors";
import type { HelloFrame } from "../protocol/version";
import { userOf } from "./cacheSession";
import { credentialsEpochOf, endedSessionOf, type QuickdrawConnection } from "./connection";

/** Who one call of a mutation hook is made as, and under which credentials. */
export interface Ticket {
  /** The credentials epoch it was issued under (`credentialsEpochOf`). */
  readonly epoch: number;
  /** The user it is made as (`null`: anonymous); `undefined` while none is known, and for good if none will be. */
  user(): string | null | undefined;
  /** True while a call issued with no hello awaits the hello that will name its user. */
  waiting(): boolean;
  /**
   * The socket's next hello: a call that awaits one takes it as its
   * listener on the connection would, before that listener runs (the calls
   * a socket holds decide on its hello first). Nothing for any other.
   */
  hear(hello: HelloFrame): void;
}

/** The ticket of a call issued on `connection` now. */
export function ticketOf(connection: QuickdrawConnection): Ticket {
  const epoch = credentialsEpochOf(connection);
  const { hello } = connection.getState();
  if (hello !== null) {
    const userId = userOf(hello);
    return Object.freeze({
      epoch,
      user: () => userId,
      waiting: () => false,
      hear: () => undefined,
    });
  }
  // No hello: the call waits for the next socket, and is the user's its hello names, settled or
  // not (its refused item's retry() is theirs); after a session the server ended, only if it
  // names that session's user again.
  const ended = endedSessionOf(connection)?.hello ?? null;
  let userId: string | null | undefined;
  let waiting = true;
  let stopHellos = (): void => undefined;
  let stopEpochs = (): void => undefined;
  const hear = (next: HelloFrame | undefined): void => {
    if (!waiting) {
      return;
    }
    waiting = false;
    stopHellos();
    stopEpochs();
    // Other credentials since, or another user than the ended session's: not made as them.
    if (
      next !== undefined &&
      credentialsEpochOf(connection) === epoch &&
      (ended === null || userOf(ended) === userOf(next))
    ) {
      userId = userOf(next);
    }
  };
  stopHellos = connection.onHello(hear);
  // Other credentials, or a session the server ends, before any hello: nobody's, for good.
  stopEpochs = connection.subscribe(() => {
    if (credentialsEpochOf(connection) !== epoch) {
      hear(undefined);
    }
  });
  return Object.freeze({ epoch, user: () => userId, waiting: () => waiting, hear });
}

/**
 * For a call no hello has named the user of: true under the epoch it was
 * made under, while no hello is held, or while it awaits the one that will
 * name its user. Once a hello names someone without making the call theirs,
 * it is nobody's to show or to send.
 */
function unclaimed(ticket: Ticket, hello: HelloFrame | null, epoch: number): boolean {
  return epoch === ticket.epoch && (hello === null || ticket.waiting());
}

/**
 * True when a call made with `ticket` may be sent now, while the connection
 * holds `hello` under credentials epoch `epoch`.
 */
export function sendable(ticket: Ticket, hello: HelloFrame | null, epoch: number): boolean {
  const user = ticket.user();
  if (user === undefined) {
    return unclaimed(ticket, hello, epoch);
  }
  // Whether the hello names the call's user: undefined while none is held.
  const same = hello === null ? undefined : userOf(hello) === user;
  if (epoch === ticket.epoch) {
    // The credentials it was made under, unless they name another user now.
    return same !== false;
  }
  // Other credentials since: only their hello naming its user may send it.
  return same === true;
}

/** The refusals made for a user change (`checkedTicket`, `refusalAt`), which no retry sends. */
const refusals = new WeakSet<QuickdrawError>();

/** Those of a mutation hook's own check (`checkedTicket`), made before the attempt's optimistic update. */
const beforeUpdate = new WeakSet<QuickdrawError>();

/** True for the refusal of a call whose user changed before it was sent (`checkedTicket`, `refusalAt`). */
export function isUserChange(error: unknown): error is QuickdrawError {
  return error instanceof QuickdrawError && refusals.has(error);
}

/**
 * True for a refusal of a mutation hook's check (`checkedTicket`): made at
 * the start of an attempt, before its optimistic update ran, so the update
 * added nothing anew.
 */
export function isCheckRefusal(error: unknown): error is QuickdrawError {
  return error instanceof QuickdrawError && beforeUpdate.has(error);
}

/**
 * The refusal of the call that `stopped`, a ticket it was made with, keeps
 * from being sent on `connection` now: `CANCELLED`, as for a call new
 * credentials found waiting to be sent. Its words say why: a hello names a
 * user it is not made as (under its own credentials, for a call no hello
 * made anyone's); or it was made under other credentials, or before a
 * session the server ended, and no hello names its user since; or the hook
 * holds no ticket for it.
 */
function refusalOn(
  connection: QuickdrawConnection,
  stopped: Ticket | undefined,
  hello: HelloFrame | null = connection.getState().hello,
): QuickdrawError {
  const user = stopped?.user();
  const otherUser =
    hello !== null &&
    (user === undefined
      ? stopped?.epoch === credentialsEpochOf(connection)
      : userOf(hello) !== user);
  let message = "The user changed before the call was sent";
  if (stopped === undefined) {
    message = "The call was not sent: nothing says which user made it";
  } else if (!otherUser) {
    message =
      endedSessionOf(connection) === undefined
        ? "The credentials changed before the call was sent"
        : "The session ended before the call was sent";
  }
  const refusal = new QuickdrawError("CANCELLED", message);
  refusals.add(refusal);
  return refusal;
}

/**
 * The ticket of the call made with `variables`, the first the hook holds
 * for that value, when every ticket it holds for it may be sent on
 * `connection` now; else throws the call's refusal. A call the hook holds
 * no ticket for (made outside it, or one TanStack dropped and still ran) is
 * refused too: nothing says whose it is.
 */
export function checkedTicket(
  tickets: Tickets,
  variables: unknown,
  connection: QuickdrawConnection,
): Ticket {
  const held = tickets.of(variables);
  const [ticket] = held;
  const { hello } = connection.getState();
  const epoch = credentialsEpochOf(connection);
  const stopped = held.find((each) => !sendable(each, hello, epoch));
  if (ticket !== undefined && stopped === undefined) {
    return ticket;
  }
  const refusal = refusalOn(connection, stopped);
  beforeUpdate.add(refusal);
  throw refusal;
}

/**
 * Whether a call made with `ticket` may go out on a socket whose own hello
 * is `hello` (`call.ts`), which the ticket hears first: `undefined` when it
 * may, else its refusal, `CANCELLED` and worded as `checkedTicket` words it.
 */
export function refusalAt(
  ticket: Ticket,
  hello: HelloFrame,
  connection: QuickdrawConnection,
): QuickdrawError | undefined {
  ticket.hear(hello);
  if (sendable(ticket, hello, credentialsEpochOf(connection))) {
    return undefined;
  }
  return refusalOn(connection, ticket, hello);
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
    return unclaimed(ticket, hello, epoch);
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
  /** The tickets held for calls made with `variables`, oldest first. */
  of(variables: unknown): readonly Ticket[];
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
    of: (variables: unknown): readonly Ticket[] => heldFor(variables) ?? [],
  });
}
