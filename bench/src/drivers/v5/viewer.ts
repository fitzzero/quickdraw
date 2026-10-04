import { collectionTopic, QuickdrawError } from "@fitzzero/quickdraw-core";
import {
  DEFAULT_INVALIDATION_WINDOW_MS,
  createInvalidationCoordinator,
  liveDataOf,
  methodKey,
  refetchOnAccessChanges,
  sessionOf,
  shouldRetry,
  type InvalidationCoordinator,
  type LiveData,
  type QuickdrawConnection,
} from "@fitzzero/quickdraw-core/client";
import {
  QueryClient,
  QueryObserver,
  hashKey,
  type QueryObserverOptions,
  type QueryObserverResult,
} from "@tanstack/react-query";
import { taskContract } from "bench-app-v5/contracts";
import type { Outcome } from "../../recorder";
import type { BoardViewer, DriverContext, LoadResult } from "../types";
import { readStamp } from "../writes";
import { openConnection, queriesMayRun, recordedCall } from "./client";

/**
 * A board viewer, running what a 5.0 board page runs: `QuickdrawProvider`
 * with `qd.task.cardsByProject.useCollection(projectId)`,
 * `qd.task.useEntities(ids)` for the 60 on-screen cards and
 * `qd.task.getTasksByStatus.useQuery({ projectId })`, without React.
 *
 * The connection, the live data (entity and collection stores, resume by
 * revision on every reconnect), the invalidation coordinator, the cache
 * session and the subscription lane are the 5.0 client's own objects, wired
 * the way the provider wires them (`packages/core/src/client/provider.tsx`).
 * The query hook's own glue (`hooks.ts`, `queryHooks.ts`) is reproduced on a
 * TanStack `QueryObserver`: it joins the query's change topic and has the
 * coordinator invalidate the query on each `qd:changed`, holds its read
 * until the topic's join is answered, runs only while the connection is
 * connected, the hello is in and queries are not backing off, retries once
 * after `INTERNAL`, and keeps the provider's default 5-minute stale time.
 */

const SERVICE = taskContract.name;
const COLLECTION = "cardsByProject";
const BOARD_QUERY = "getTasksByStatus";

/** A query refetch can start up to one coordinator window after the change that asked for it. */
const WINDOW_SLACK_MS = 50;

/** The codes after which the query hook drops the cached result (`query.ts`). */
const REFUSALS: ReadonlySet<string> = new Set(["FORBIDDEN", "UNAUTHENTICATED", "NOT_FOUND"]);

/** A load (the first one, or the restore after a drop) and what has answered so far. */
interface Load {
  readonly startedAt: number;
  /** `Date.now()` at the start, to compare with the query's `dataUpdatedAt`. */
  readonly startedAtEpoch: number;
  entities: boolean;
  collection: boolean;
  query: boolean;
  liveAt: number | undefined;
  readonly resolve: (result: LoadResult) => void;
}

function createQueryClient(): QueryClient {
  // QuickdrawProvider's default client.
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false } },
  });
}

/** `untilJoined`, or sooner when `signal` aborts. */
async function untilJoinedOrAborted(
  joined: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    await joined;
    return;
  }
  await new Promise<void>((resolve) => {
    const done = (): void => {
      signal.removeEventListener("abort", done);
      resolve();
    };
    if (signal.aborted) {
      done();
      return;
    }
    signal.addEventListener("abort", done, { once: true });
    void joined.then(done);
  });
}

export class V5Viewer implements BoardViewer {
  private readonly connection: QuickdrawConnection;
  private readonly queryClient = createQueryClient();
  private readonly coordinator: InvalidationCoordinator;
  private readonly live: LiveData;
  private readonly queryKey: readonly unknown[];
  private readonly queryHash: string;
  private readonly topic: string;
  private readonly observer: QueryObserver<unknown, QuickdrawError>;
  private readonly releases: Array<() => void> = [];
  /** When the last `qd:changed` arrived, and when the last read of the query started. */
  private lastChangedAt = Number.NEGATIVE_INFINITY;
  private lastReadAt = Number.NEGATIVE_INFINITY;
  private load: Load | null = null;

  constructor(
    private readonly ctx: DriverContext,
    token: string,
    private readonly projectId: string,
    private readonly entityIds: readonly string[],
  ) {
    this.connection = openConnection(ctx, token, (event, outcome) => this.onAck(event, outcome));
    this.coordinator = createInvalidationCoordinator(this.queryClient);
    // What the provider sets up for its connection and client.
    sessionOf(this.connection, this.queryClient);
    this.live = liveDataOf(this.connection, this.queryClient);
    this.connection.onReconnect(() => {
      this.coordinator.refetchAfterReconnect({
        watched: (query) => query.queryHash === this.queryHash,
      });
    });
    refetchOnAccessChanges(this.connection, this.coordinator);
    this.queryKey = methodKey(SERVICE, BOARD_QUERY, { projectId });
    this.queryHash = hashKey(this.queryKey);
    this.topic = collectionTopic(COLLECTION, projectId);
    this.observer = new QueryObserver(this.queryClient, this.queryOptions());
    this.listenForDelivery();
  }

  /** Connect and load the board; resolves when the collection, the rows and the query have answered. */
  public async open(): Promise<LoadResult> {
    const loaded = this.nextLoad();
    this.mount();
    return await loaded;
  }

  /** Drop the connection and reconnect straight away; resolves when the board is restored. */
  public async drop(): Promise<LoadResult> {
    const restored = this.nextLoad();
    this.connection.socket.disconnect();
    this.connection.socket.connect();
    return await restored;
  }

  /** True while the client still has work queued: a frame or read in flight, or a refetch owed. */
  public get busy(): boolean {
    const lane = this.connection.subscriptionLane;
    const query = this.queryClient.getQueryCache().find({ queryKey: this.queryKey, exact: true });
    return (
      this.load !== null ||
      lane.inFlight() + lane.waiting() > 0 ||
      query?.state.fetchStatus === "fetching" ||
      this.refetchOwed()
    );
  }

  /**
   * True while the coordinator may still owe the query a refetch: a change
   * arrived after its last read started, and the window that read opened
   * (when the coordinator fires the owed refetch) has not ended yet. A change
   * with no window open starts its read at once, and a change during a read
   * is served when the read settles, so both show as a read in flight.
   */
  private refetchOwed(): boolean {
    if (this.lastChangedAt <= this.lastReadAt) return false;
    const since = Number.isFinite(this.lastReadAt) ? this.lastReadAt : this.lastChangedAt;
    return performance.now() < since + DEFAULT_INVALIDATION_WINDOW_MS + WINDOW_SLACK_MS;
  }

  public close(): void {
    for (const release of this.releases.splice(0).reverse()) release();
    this.observer.destroy();
    this.connection.close();
    this.queryClient.clear();
  }

  /** Mounts the board page: the provider's holds, the collection, the rows and the watched query. */
  private mount(): void {
    const def = taskContract.collections[COLLECTION];
    const scope = this.live.collections.subscribe(
      { service: SERVICE, collection: COLLECTION, def },
      this.projectId,
    );
    this.releases.push(
      () => scope.release(),
      this.live.entities.subscribe(SERVICE, this.entityIds),
      this.connection.watch({
        service: SERVICE,
        topic: this.topic,
        key: this.queryHash,
        onChanged: () => {
          this.lastChangedAt = performance.now();
          this.coordinator.invalidate(this.queryKey, { exact: true });
        },
        onJoined: () => {
          if (this.wasRead()) this.coordinator.invalidate(this.queryKey, { exact: true });
        },
      }),
      this.observer.subscribe((result) => this.onQueryResult(result)),
      this.connection.subscribe(() => this.observer.setOptions(this.queryOptions())),
      this.coordinator.retain(),
      this.connection.retain(),
    );
  }

  private queryOptions(): QueryObserverOptions<unknown, QuickdrawError> {
    return {
      queryKey: this.queryKey,
      queryFn: async ({ signal }) => await this.readBoard(signal),
      enabled: queriesMayRun(this.connection),
      retry: shouldRetry,
    };
  }

  /**
   * The query hook's fetch for this query (`readAfterJoin`, then
   * `fetchMethodQuery`): wait for its topic's join, then call. The output is
   * a schema without a `version`, so no version is sent or kept.
   */
  private async readBoard(signal: AbortSignal | undefined): Promise<unknown> {
    this.lastReadAt = performance.now();
    const joined = this.connection.waitForJoin({
      service: SERVICE,
      topic: this.topic,
      key: this.queryHash,
    });
    if (joined !== undefined) await untilJoinedOrAborted(joined, signal);
    const call = await recordedCall(this.ctx.recorder, this.connection, {
      service: SERVICE,
      method: BOARD_QUERY,
      input: { projectId: this.projectId },
      kind: "query",
      signal,
    });
    if (call.error === undefined) return (call.result as { d: unknown }).d;
    if (call.error instanceof QuickdrawError && REFUSALS.has(call.error.code)) {
      // The hook takes a refused result out of the query, so no data shows beside the error.
      const query = this.queryClient.getQueryCache().find({ queryKey: this.queryKey, exact: true });
      if (query?.state.data !== undefined) query.setState({ ...query.state, data: undefined });
    }
    throw call.error;
  }

  /** True once a read of the query was sent: it holds a result or an error, or is reading. */
  private wasRead(): boolean {
    const query = this.queryClient.getQueryCache().find({ queryKey: this.queryKey, exact: true });
    if (query === undefined) return false;
    const { dataUpdatedAt, errorUpdatedAt, fetchStatus } = query.state;
    return dataUpdatedAt > 0 || errorUpdatedAt > 0 || fetchStatus !== "idle";
  }

  private nextLoad(): Promise<LoadResult> {
    return new Promise((resolve) => {
      this.load = {
        startedAt: performance.now(),
        startedAtEpoch: Date.now(),
        entities: false,
        collection: false,
        query: false,
        liveAt: undefined,
        resolve,
      };
    });
  }

  private onAck(event: string, outcome: Outcome): void {
    const load = this.load;
    if (load === null) return;
    if (!outcome.ok) {
      if (outcome.reason !== "abandoned") {
        this.finish({ ok: false, failure: `${event}: ${outcome.error ?? outcome.reason}` });
      }
      return;
    }
    if (event === "qd:sub") load.entities = true;
    if (event === "qd:col:sub") load.collection = true;
    this.progress(load);
  }

  private onQueryResult(result: QueryObserverResult<unknown, QuickdrawError>): void {
    const load = this.load;
    if (load === null || result.fetchStatus !== "idle") return;
    if (result.status === "success" && result.dataUpdatedAt >= load.startedAtEpoch) {
      load.query = true;
      this.progress(load);
    } else if (result.status === "error" && result.errorUpdatedAt >= load.startedAtEpoch) {
      this.finish({ ok: false, failure: `query: ${result.error.message}` });
    }
  }

  private progress(load: Load): void {
    if (load.liveAt === undefined && load.entities && load.collection) {
      load.liveAt = performance.now();
    }
    if (load.entities && load.collection && load.query) this.finish({ ok: true });
  }

  private finish(result: Pick<LoadResult, "ok" | "failure">): void {
    const load = this.load;
    if (load === null) return;
    this.load = null;
    const ms = performance.now() - load.startedAt;
    const liveMs = load.liveAt === undefined ? undefined : load.liveAt - load.startedAt;
    load.resolve({ ...result, ms, ...(liveMs === undefined ? {} : { liveMs }) });
  }

  /** Times each change from the writer's stamp to this viewer receiving its frame. */
  private listenForDelivery(): void {
    const socket = this.connection.socket as unknown as {
      on(event: string, listener: (frame: unknown) => void): void;
    };
    const deliver = (kind: string, title: unknown): void => {
      const stamp = readStamp(title);
      if (stamp !== null) this.ctx.recorder.deliver(kind, performance.now() - stamp);
    };
    socket.on("qd:e", (frame) => {
      const { t, d } = frame as { t?: string; d?: { title?: unknown } };
      if (t === "p" || t === "u") deliver("entityUpdate", d?.title);
    });
    socket.on("qd:c", (frame) => {
      const { deltas } = frame as {
        deltas?: Array<{ d?: { title?: unknown }; item?: { title?: unknown } }>;
      };
      for (const delta of deltas ?? [])
        deliver("collectionDelta", delta.d?.title ?? delta.item?.title);
    });
  }
}
