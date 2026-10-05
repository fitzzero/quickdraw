// The live collections of one connection and `QueryClient` (RFC 0003
// sections 7 and 11.5): one controller per scope (`collectionController.ts`),
// counted by the hooks that hold it (`registry.ts`), with `qd:c` and
// `qd:revoked` frames routed to it by `service`, `collection` and `scope`.
// While any scope is held, the visibility and idle checks run (`resume.ts`),
// and a mutation call whose outcome is unknown has each held scope it added
// an item to loaded again once: that load says whether the server made it
// (`../additions.ts`). After a lost connection, the reconnect's own resume
// does. A scope whose load was refused is loaded once more when the user's
// access may have changed: on new service grants (`qd:access`, from
// `liveData.ts`), and when an `added` delta of another held scope names its
// anchor row (finding F8.4); every connect loads it again too.
//
// React-free: the live data (`liveData.ts`) makes one per connection and
// `QueryClient`.

import type { CollectionFrame, Revision, RevokeReason } from "../../protocol/envelope";
import { isName, isRecord } from "../../protocol/guards";
import {
  createCollectionController,
  type CollectionController,
  type CollectionTarget,
  type ResumeReason,
} from "./collectionController";
import { storeOf } from "../optimistic";
import type { CollectionEntry } from "./collectionLoads";
import { isRevision, readEntry, type LiveHost } from "./host";
import { createRegistry } from "./registry";
import { createResumeChecks } from "./resume";

/** How a hook holds a scope. */
export interface ScopeOptions {
  /** The page size to ask for; the first holder's applies to the scope. */
  readonly limit?: number | undefined;
  /** True to load every page of the scope while held. */
  readonly loadAll?: boolean;
}

/** One holding of a scope: its controller, and the release. */
export interface ScopeHolding {
  readonly controller: CollectionController;
  /** Ends this holding. The scope is unsubscribed a tick after its last holding ends. */
  release(): void;
}

/** The live collections of one connection and `QueryClient`. */
export interface CollectionHub {
  /** Holds one scope of a collection for one user of it. */
  subscribe(target: CollectionTarget, scope: string, options?: ScopeOptions): ScopeHolding;
  /** True while a user holds `scope` of `collection`: its deltas arrive and apply to its state. */
  holds(service: string, collection: string, scope: string): boolean;
  /**
   * Keeps items of a held scope that were read outside it at revision `rev`
   * (a search's results) in its state (`CollectionController.keep`). Returns
   * false, keeping nothing, when the scope is not held or not loaded yet.
   */
  keep(
    service: string,
    collection: string,
    scope: string,
    items: readonly unknown[],
    rev: Revision,
  ): boolean;
  /** A `qd:c` frame arrived. */
  receive(frame: unknown): void;
  /** The server ended the subscription to a scope (`qd:revoked`). */
  revoked(service: string, collection: string, scope: string, reason: RevokeReason): void;
  /** Loads every held scope again from the revision it holds. */
  resume(reason: ResumeReason): void;
  /**
   * The user's access may have changed (new service grants): loads each held
   * scope whose last load was refused once more.
   */
  reopen(): void;
  /** Another user acts on the connection now: drops every scope's state and loads it again. */
  forget(): void;
  /** The connection closed: stops every scope's timers and the checks, until the next connect. */
  stop(): void;
  /** How many scopes are held. */
  size(): number;
}

function scopeKey(service: string, collection: string, scope: string): string {
  return `${service}\u0000${collection}\u0000${scope}`;
}

/** True when `value` has the shape of a `qd:c` frame. Frames come over the network: checked, not trusted. */
function isCollectionFrame(value: unknown): value is CollectionFrame {
  return (
    isRecord(value) &&
    isName(value.s) &&
    isName(value.c) &&
    isName(value.scope) &&
    isRevision(value.rev) &&
    Array.isArray(value.deltas)
  );
}

/** The refusals that drop a scope's state. */
const REFUSALS: ReadonlySet<string> = new Set(["FORBIDDEN", "NOT_FOUND", "UNAUTHENTICATED"]);

/** Loads `controllers`' scopes whose last load was refused once more: the user's access may have changed. */
function reopen(host: LiveHost, controllers: readonly CollectionController[]): void {
  for (const controller of controllers) {
    const entry = readEntry<CollectionEntry>(host, controller.key);
    if (entry?.state === null && entry.error !== null && REFUSALS.has(entry.error.code)) {
      void controller.refresh();
    }
  }
}

/**
 * The held scopes anchored on a row `frame` adds to another scope: an invite
 * adds the chat to the user's list of chats, and the chat's messages' scope
 * is that chat's id.
 */
function anchoredOn(
  controllers: readonly CollectionController[],
  frame: CollectionFrame,
): CollectionController[] {
  const added = new Set<string>();
  for (const delta of frame.deltas as readonly unknown[]) {
    const item = isRecord(delta) && delta.t === "added" && isRecord(delta.item) ? delta.item : null;
    if (item !== null && typeof item.id === "string") {
      added.add(item.id);
    }
  }
  return added.size === 0 ? [] : controllers.filter((controller) => added.has(controller.scope));
}

/** Asks for a load of each scope that holds additions of unknown outcome, once each, while started. */
function createOutcomeChecks(
  host: LiveHost,
  ask: (service: string, collection: string, scope: string) => void,
): { start(): void; stop(): void } {
  const store = storeOf(host.queryClient);
  let unsubscribe: (() => void) | undefined;
  let queued = false;
  const check = (): void => {
    queued = false;
    for (const { service, collection, scope } of store.unchecked()) {
      ask(service, collection, scope);
    }
  };
  return {
    start() {
      // A change of the store is told inside the mutation's failure: ask after it.
      unsubscribe ??= store.subscribe(() => {
        if (!queued) {
          queued = true;
          queueMicrotask(check);
        }
      });
    },
    stop() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}

/** Creates the live collections of `host`. */
export function createCollectionHub(host: LiveHost): CollectionHub {
  const registry = createRegistry<CollectionController>((controller) => {
    controller.dispose();
    if (registry.held().length === 0) {
      checks.stop();
      outcomes.stop();
    }
  });
  const each = (act: (controller: CollectionController) => void): void => {
    registry.held().forEach(act);
  };
  const checks = createResumeChecks(() => {
    each((controller) => controller.resume("check"));
  });
  const held = (service: string, collection: string, scope: string) =>
    registry.get(scopeKey(service, collection, scope));
  const outcomes = createOutcomeChecks(host, (service, collection, scope) => {
    held(service, collection, scope)?.resume("check");
  });
  return Object.freeze({
    subscribe(target: CollectionTarget, scope: string, options: ScopeOptions = {}): ScopeHolding {
      const holding = registry.acquire(scopeKey(target.service, target.collection, scope), () =>
        createCollectionController(host, target, scope, options.limit),
      );
      const { entry: controller } = holding;
      const stopAll = options.loadAll === true ? controller.loadAll() : undefined;
      if (holding.isNew) {
        controller.start();
      }
      checks.start();
      outcomes.start();
      return {
        controller,
        release: () => {
          stopAll?.();
          holding.release();
        },
      };
    },
    holds: (service: string, collection: string, scope: string) =>
      held(service, collection, scope) !== undefined,
    keep: (
      service: string,
      collection: string,
      scope: string,
      items: readonly unknown[],
      rev: Revision,
    ) => held(service, collection, scope)?.keep(items, rev) ?? false,
    receive(frame: unknown): void {
      if (isCollectionFrame(frame)) {
        held(frame.s, frame.c, frame.scope)?.receive(frame);
        reopen(host, anchoredOn(registry.held(), frame));
      }
    },
    reopen: () => {
      reopen(host, registry.held());
    },
    revoked(service: string, collection: string, scope: string, reason: RevokeReason): void {
      held(service, collection, scope)?.revoked(reason);
    },
    resume(reason: ResumeReason): void {
      const scopes = registry.held();
      for (const controller of scopes) {
        controller.resume(reason);
      }
      if (reason === "connect" && scopes.length > 0) {
        checks.start();
      }
    },
    forget(): void {
      each((controller) => controller.forget());
    },
    stop(): void {
      each((controller) => controller.stop());
      checks.stop();
    },
    size: () => registry.held().length,
  });
}
