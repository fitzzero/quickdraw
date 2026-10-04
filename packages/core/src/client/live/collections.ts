// The live collections of one connection and `QueryClient` (RFC 0003
// sections 7 and 11.5): one controller per scope (`collectionController.ts`),
// counted by the hooks that hold it (`registry.ts`), with `qd:c` and
// `qd:revoked` frames routed to it by `service`, `collection` and `scope`.
// While any scope is held, the visibility and idle checks run (`resume.ts`).
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
import { isRevision, type LiveHost } from "./host";
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

/** Creates the live collections of `host`. */
export function createCollectionHub(host: LiveHost): CollectionHub {
  const registry = createRegistry<CollectionController>((controller) => {
    controller.dispose();
    if (registry.held().length === 0) {
      checks.stop();
    }
  });
  const checks = createResumeChecks(() => {
    for (const controller of registry.held()) {
      controller.resume("check");
    }
  });
  const held = (service: string, collection: string, scope: string) =>
    registry.get(scopeKey(service, collection, scope));
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
      }
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
      for (const controller of registry.held()) {
        controller.forget();
      }
    },
    stop(): void {
      for (const controller of registry.held()) {
        controller.stop();
      }
      checks.stop();
    },
    size: () => registry.held().length,
  });
}
