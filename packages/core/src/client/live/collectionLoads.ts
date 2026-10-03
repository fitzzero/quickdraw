// The requests a collection scope's pipeline makes besides loading the scope
// (RFC 0003 sections 7.3 and 7.4): the next page by cursor (`loadMore`, and
// every page for `load: "all"`), and items by id (`qd:col:items`, at most
// 200 ids each). Split from `collectionController.ts`.
//
// A page is dropped when a load of the scope started after it was asked for
// (a reset, a refresh, a resume answered with a snapshot): that load brings
// its own first page and cursor. Items are applied by revision whenever they
// arrive (`collectionStore.ts`), so they need no such guard.
//
// React-free.

import type { CollectionDef } from "../../contract/collections";
import { CLIENT_EVENTS } from "../../contract/names";
import { QuickdrawError } from "../../protocol/errors";
import type { CollectionQueryKey } from "../keys";
import type { CollectionShape } from "./collectionIndex";
import {
  applyItems,
  applyPage,
  type CollectionItem,
  type CollectionState,
} from "./collectionStore";
import { chunks, isRevision, malformed, request, type LiveHost, type Outcome } from "./host";

/** The most ids one `qd:col:items` may name (RFC 0003 section 7.4). */
export const MAX_ITEM_IDS = 200;

/** What the cache holds for one collection scope, under `["qd", service, "c", collection, scope]`. */
export interface CollectionEntry<Item extends CollectionItem = CollectionItem> {
  /** The scope's state; `null` before its first load, and once a refusal or revocation dropped it. */
  readonly state: CollectionState<Item> | null;
  /** Why the last request failed, or why the server ended the subscription. */
  readonly error: QuickdrawError | null;
  /** True while a page is being loaded. */
  readonly loadingMore: boolean;
}

/** One collection of one service, as a controller loads it. */
export interface CollectionTarget {
  /** The service's name on the wire. */
  readonly service: string;
  readonly collection: string;
  /** The contract's declaration: `order`, `index`, `views` and page sizes. */
  readonly def: CollectionDef;
}

/** What the page and item requests need of a scope's pipeline. */
export interface LoadSteps {
  readonly host: LiveHost;
  readonly target: CollectionTarget;
  readonly scope: string;
  readonly key: CollectionQueryKey;
  readonly shape: CollectionShape;
  /** The page size the first user asked for. */
  readonly limit: number | undefined;
  /** Raised by every load of the scope: a page asked for before it is dropped. */
  generation: number;
  disposed: boolean;
  /** The page in flight, shared by everyone who asks for the next page meanwhile. */
  page: Promise<boolean> | undefined;
  /** The waits before a page or items are asked for again, each with what ends it early. */
  readonly waits: Map<ReturnType<typeof setTimeout>, () => void>;
  /** The page size to ask for now. */
  pageLimit(): number | undefined;
  currentState(): CollectionState | null;
  write(change: Partial<CollectionEntry>): void;
  /** Resolves once the server has the socket in the scope's room; rejects when loading the scope is refused. */
  whenJoined(): Promise<void>;
}

/** True when `reply` has the shape of a page: `{ rev, items, total, cursor }`. */
export function isPage(reply: Readonly<Record<string, unknown>>): reply is Readonly<
  Record<string, unknown>
> & {
  readonly rev: number;
  readonly items: readonly unknown[];
  readonly total: number;
  readonly cursor: string | null;
} {
  return (
    isRevision(reply.rev) &&
    Array.isArray(reply.items) &&
    typeof reply.total === "number" &&
    (reply.cursor === null || typeof reply.cursor === "string")
  );
}

/** Reports the revision items were read at to the overlay store. */
export function observeItems(p: LoadSteps, items: readonly unknown[], rev: number): void {
  for (const item of items) {
    const id = (item as { readonly id?: unknown } | null)?.id;
    if (typeof id === "string") {
      p.host.overlays.observe(p.target.service, id, rev);
    }
  }
}

/** Runs `then` after `delayMs`, unless the waits are ended first (`endWaits`), which runs `ended`. */
function wait(p: LoadSteps, delayMs: number, then: () => void, ended: () => void): void {
  const timer = setTimeout(() => {
    p.waits.delete(timer);
    then();
  }, delayMs);
  p.waits.set(timer, ended);
}

/** Ends every wait before a page or items are asked for again: the scope is disposed, or the connection closed. */
export function endWaits(p: LoadSteps): void {
  const waits = [...p.waits];
  p.waits.clear();
  for (const [timer, ended] of waits) {
    clearTimeout(timer);
    ended();
  }
}

function scopeFrame(p: LoadSteps): {
  readonly s: string;
  readonly c: string;
  readonly scope: string;
} {
  return { s: p.target.service, c: p.target.collection, scope: p.scope };
}

/** Applies the answer to a page; resolves true to go on reading pages, false to stop. */
function pageLoaded(
  p: LoadSteps,
  generation: number,
  outcome: Outcome,
): boolean | Promise<boolean> {
  if (generation !== p.generation) {
    p.write({ loadingMore: false });
    return false;
  }
  if (outcome.kind === "ok") {
    const { reply } = outcome;
    if (!isPage(reply)) {
      p.write({ loadingMore: false, error: malformed("qd:col:sub") });
      return false;
    }
    observeItems(p, reply.items, reply.rev);
    p.write({
      loadingMore: false,
      error: null,
      state: applyPage(p.currentState(), reply, p.shape),
    });
    return true;
  }
  p.write(
    outcome.kind === "refused"
      ? { loadingMore: false, error: outcome.error }
      : { loadingMore: false },
  );
  if (outcome.kind === "retry") {
    return new Promise((resolve) => {
      wait(
        p,
        outcome.delayMs,
        () => {
          resolve(true);
        },
        () => {
          resolve(false);
        },
      );
    });
  }
  return false;
}

/**
 * Loads the next page by cursor, unless there is none. Resolves `true` when
 * it was applied (or should be asked for again), `false` when there was no
 * page, it failed, or a load of the scope cancelled it.
 */
export function loadPage(p: LoadSteps): Promise<boolean> {
  if (p.page !== undefined) {
    return p.page;
  }
  const cursor = p.currentState()?.nextCursor ?? null;
  if (cursor === null || p.disposed) {
    return Promise.resolve(false);
  }
  const { generation } = p;
  const limit = p.pageLimit();
  const frame = { ...scopeFrame(p), cursor, ...(limit === undefined ? {} : { limit }) };
  p.write({ loadingMore: true });
  let answered = false;
  const page = new Promise<boolean>((resolve) => {
    request(p.host, CLIENT_EVENTS.collectionSub, frame, (outcome) => {
      answered = true;
      p.page = undefined;
      resolve(p.disposed ? false : pageLoaded(p, generation, outcome));
    });
  });
  // With the socket down the lane answers at once, before `page` is made.
  if (!answered) {
    p.page = page;
  }
  return page;
}

/** Sends one `qd:col:items` and applies its answer. */
function requestItems(p: LoadSteps, ids: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    request(p.host, CLIENT_EVENTS.collectionItems, { ...scopeFrame(p), ids }, (outcome) => {
      const state = p.currentState();
      if (p.disposed || state === null) {
        resolve();
      } else if (outcome.kind === "ok") {
        const { rev, items } = outcome.reply;
        if (!isRevision(rev) || !Array.isArray(items)) {
          reject(malformed("qd:col:items"));
          return;
        }
        observeItems(p, items, rev);
        p.write({ state: applyItems(state, items, rev, p.shape, ids) });
        resolve();
      } else if (outcome.kind === "retry") {
        wait(
          p,
          outcome.delayMs,
          () => {
            requestItems(p, ids).then(resolve, reject);
          },
          () => {
            if (p.disposed) {
              resolve();
            } else {
              reject(new QuickdrawError("INTERNAL", "The connection to the server closed"));
            }
          },
        );
      } else {
        reject(
          outcome.kind === "refused"
            ? outcome.error
            : new QuickdrawError("INTERNAL", "The connection to the server is down"),
        );
      }
    });
  });
}

/**
 * Loads the items of `ids` with `qd:col:items`, at most 200 per request,
 * once the scope is joined. Rejects with the error a request was refused
 * with.
 */
export async function loadItems(p: LoadSteps, ids: readonly string[]): Promise<void> {
  const wanted = [...new Set(ids.filter((id) => typeof id === "string" && id !== ""))];
  if (wanted.length === 0 || p.disposed) {
    return;
  }
  await p.whenJoined();
  if (p.disposed) {
    return;
  }
  await Promise.all(chunks(wanted, MAX_ITEM_IDS).map((run) => requestItems(p, run)));
}
