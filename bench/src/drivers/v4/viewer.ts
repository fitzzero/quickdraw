import type { Outcome } from "../../recorder";
import { V4Connection, type DriverContext } from "./connection";
import {
  CLIENT_TIMEOUT_MS,
  COLLECTION,
  EVENTS,
  INVALIDATE_DEBOUNCE_MS,
  QUERY_RETRIES,
  QUERY_RETRY_DELAY_MS,
  collectionEvent,
  entityUpdateEvent,
  readStamp,
} from "./protocol";

/**
 * A board viewer, reproducing on the wire what a 4.1 React board page does
 * with `useCollection`, 60 `useSubscription`s and one `useServiceQuery`:
 *
 * - on connect: `collection:subscribe` (10 s timeout), one `batchSubscribe`
 *   for all 60 rows (the provider's batcher sends one per microtask; no
 *   timeout), and the board query;
 * - every collection delta invalidates the query after a 100 ms debounce, and
 *   an invalidation while a refetch is in flight starts a new request anyway
 *   (TanStack's cancelRefetch; 4.1 cannot cancel on the server);
 * - a failed query is retried once after 1 s;
 * - on disconnect every subscription cleans up while offline, so its
 *   `unsubscribe` is buffered and sent when the connection comes back, and on
 *   reconnect everything above happens again.
 */

export interface LoadResult {
  ok: boolean;
  ms: number;
  failure?: string;
}

interface QueryAttempt {
  cancelled: boolean;
  retriesLeft: number;
}

type Piece = "collection" | "entities" | "query";

export class Viewer {
  private readonly conn: V4Connection;
  private readonly deltaEvent: string;
  private hasQueryData = false;
  private attempt: QueryAttempt | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private loaded = new Set<Piece>();
  private loadStartedAt = 0;
  private waiters: Array<(result: LoadResult) => void> = [];

  constructor(
    private readonly ctx: DriverContext,
    token: string,
    private readonly projectId: string,
    private readonly entityIds: readonly string[],
  ) {
    this.conn = new V4Connection(ctx, token);
    this.deltaEvent = collectionEvent(projectId);
    this.conn.socket.on("connect", () => this.onConnect());
    this.conn.socket.on("disconnect", () => this.onDisconnect());
  }

  /** Connect and load the board; resolves when all three reads have answered. */
  public async open(): Promise<LoadResult> {
    const loaded = this.nextLoad();
    this.conn.socket.connect();
    return await loaded;
  }

  /** Drop the connection and reconnect straight away; resolves when the board is restored. */
  public async drop(): Promise<LoadResult> {
    const restored = this.nextLoad();
    this.conn.socket.disconnect();
    this.conn.socket.connect();
    return await restored;
  }

  /** True while the viewer still has client-side work queued (a debounce or a retry). */
  public get busy(): boolean {
    return this.debounce !== null || this.retry !== null;
  }

  public close(): void {
    this.clearTimers();
    this.conn.close();
  }

  private nextLoad(): Promise<LoadResult> {
    this.loadStartedAt = performance.now();
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private onConnect(): void {
    this.loaded = new Set();
    this.conn.socket.on(this.deltaEvent, this.onDelta);
    void this.conn
      .request(
        EVENTS.collectionSubscribe,
        { collection: COLLECTION, scopeId: this.projectId },
        CLIENT_TIMEOUT_MS,
      )
      .then((outcome) => this.settle("collection", outcome));

    for (const id of this.entityIds) this.conn.socket.on(entityUpdateEvent(id), this.onEntity);
    void this.conn
      .request(EVENTS.batchSubscribe, { entryIds: this.entityIds, requiredLevel: "Read" }, null)
      .then((outcome) => this.settle("entities", outcome));

    this.fetchQuery();
  }

  private onDisconnect(): void {
    this.clearTimers();
    this.conn.socket.off(this.deltaEvent, this.onDelta);
    this.conn.socket.emit(EVENTS.collectionUnsubscribe, {
      collection: COLLECTION,
      scopeId: this.projectId,
    });
    for (const id of this.entityIds) {
      this.conn.socket.off(entityUpdateEvent(id), this.onEntity);
      this.conn.socket.emit(EVENTS.unsubscribe, { entryId: id });
    }
  }

  private readonly onDelta = (delta: { item?: { title?: unknown } }): void => {
    this.recordDelivery("collectionDelta", delta.item?.title);
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.fetchQuery();
    }, INVALIDATE_DEBOUNCE_MS);
  };

  private readonly onEntity = (update: { title?: unknown }): void => {
    this.recordDelivery("entityUpdate", update.title);
  };

  private recordDelivery(kind: string, title: unknown): void {
    const stamp = readStamp(title);
    if (stamp !== null) this.ctx.recorder.deliver(kind, performance.now() - stamp);
  }

  /** TanStack's fetch: dedupe while the first fetch is pending, otherwise cancel and refetch. */
  private fetchQuery(): void {
    if (this.attempt && !this.hasQueryData) return;
    if (this.attempt) this.attempt.cancelled = true;
    const attempt: QueryAttempt = { cancelled: false, retriesLeft: QUERY_RETRIES };
    this.attempt = attempt;
    void this.runQuery(attempt);
  }

  private async runQuery(attempt: QueryAttempt): Promise<void> {
    const outcome = await this.conn.request(
      EVENTS.getTasksByStatus,
      { projectId: this.projectId },
      CLIENT_TIMEOUT_MS,
    );
    if (attempt.cancelled) return;
    if (!outcome.ok && outcome.reason !== "abandoned" && attempt.retriesLeft > 0) {
      attempt.retriesLeft -= 1;
      this.retry = setTimeout(() => {
        this.retry = null;
        if (!attempt.cancelled) void this.runQuery(attempt);
      }, QUERY_RETRY_DELAY_MS);
      return;
    }
    this.attempt = null;
    if (outcome.ok) this.hasQueryData = true;
    this.settle("query", outcome);
  }

  private settle(piece: Piece, outcome: Outcome): void {
    if (outcome.ok) {
      this.loaded.add(piece);
      if (this.loaded.size === 3) this.resolveWaiters({ ok: true });
      return;
    }
    if (outcome.reason !== "abandoned") {
      this.resolveWaiters({ ok: false, failure: `${piece}: ${outcome.error ?? outcome.reason}` });
    }
  }

  private resolveWaiters(result: Omit<LoadResult, "ms">): void {
    const waiters = this.waiters;
    if (waiters.length === 0) return;
    this.waiters = [];
    const ms = performance.now() - this.loadStartedAt;
    for (const resolve of waiters) resolve({ ...result, ms });
  }

  /**
   * useServiceQuery's effects clean up on disconnect: the debounce timer goes,
   * and a retry waiting to fire is dropped with its attempt (a request already
   * in flight settles as abandoned and clears the attempt itself).
   */
  private clearTimers(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
      this.attempt = null;
    }
  }
}
