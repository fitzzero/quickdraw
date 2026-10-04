// The dispatcher's options and their defaults, resolved once into the
// settings every pipeline stage reads.

import { consoleLogger, type Logger } from "../../contract/logger";
import {
  createDevWarnings,
  createLoopWatch,
  strictWarningsOf,
  type DevWarnings,
  type LoopWatch,
} from "../devWarnings";
import type { ChangeLogOptions } from "../emit/changeLog";
import { createLive, type Live } from "../emit/live";
import type { Registry } from "../registry";
import type { FlushSink } from "../uow/flushSink";
import {
  resolveAccess,
  type AccessEngine,
  type AccessOptions,
  type PolicyEngine,
} from "./accessSettings";
import { createRecorder, type CallRecord, type RecordDetails } from "./metrics";
import type { VersionSource } from "./notModified";
import { resolveTracking, storageFor, type Tracking, type TrackingOptions } from "./tracking";

/**
 * The lane each socket's subscription events (`qd:sub`, `qd:col:sub`,
 * `qd:col:items`, `qd:watch`) run in, as queries run in theirs: the socket
 * rate limiter does not count those events, so this caps them instead.
 */
export interface SubscriptionLimits {
  /** Subscription events one socket may have running at once. Default 8. */
  readonly maxInFlight: number;
  /** Subscription events one socket may have waiting; past that, `RATE_LIMITED`. Default 64. */
  readonly maxQueued: number;
}

/**
 * The dispatcher's limits. The first three are what a server announces to
 * clients in `qd:hello` (`HelloLimits`).
 */
export interface DispatcherLimits {
  /** Queries one connection may run at once. Default 16. */
  readonly maxInFlightQueries: number;
  /** Queries one connection may have waiting; past that, `RATE_LIMITED`. Default 64. */
  readonly maxQueuedQueries: number;
  /** A handler's time limit when its method sets no `timeoutMs`, in milliseconds. Default 30,000. */
  readonly callTimeoutMs: number;
  /** The `retryAfterMs` of the `RATE_LIMITED` error a full queue answers with. Default 1,000. */
  readonly retryAfterMs: number;
  /** Each socket's lane of subscription events. Default 8 in flight and 64 queued. */
  readonly subscriptions: SubscriptionLimits;
}

/** The dispatcher's `limits` option: any of the limits, and any part of `subscriptions`. */
export type LimitsOptions = Partial<Omit<DispatcherLimits, "subscriptions">> & {
  readonly subscriptions?: Partial<SubscriptionLimits>;
};

/** The defaults of RFC 0003 section 9, and the subscription lane's. */
export const DEFAULT_LIMITS: DispatcherLimits = Object.freeze({
  maxInFlightQueries: 16,
  maxQueuedQueries: 64,
  callTimeoutMs: 30_000,
  retryAfterMs: 1_000,
  subscriptions: Object.freeze({ maxInFlight: 8, maxQueued: 64 }),
});

/** The longest time limit `setTimeout` honours, in milliseconds. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** The pipeline's options: every seam and limit has a default. */
export interface PipelineOptions extends TrackingOptions {
  /** Receives one entry per call, and the original error of every `INTERNAL` failure. Default: the console. */
  readonly logger?: Logger;
  /**
   * The access options (`{ cacheMs }`), or an engine of the app's own that
   * decides each method's access form. Default: the basic engine with the
   * row access of the services' policies (RFC 0003 section 4), no cache.
   */
  readonly access?: AccessEngine | AccessOptions;
  /**
   * Answers query versions for "not modified" replies, for queries that
   * declare no `version` of their own. Default: the version of the row a
   * query returns, for a query whose output is one projection row and whose
   * input has an `id`: the service's `versionColumn`, or the change log.
   */
  readonly versions?: VersionSource;
  /**
   * The in-process change log (RFC 0003 section 6): the revision of the last
   * flush that touched each row, which answers "not modified" for services
   * without a `versionColumn`. It sees only this process's writes, so an app
   * running several processes behind a load balancer passes `false` (the log
   * then answers nothing) or declares `versionColumn`s; behind a Socket.IO
   * cluster adapter it answers nothing either. Default: answering, keeping
   * 100,000 rows.
   */
  readonly changeLog?: ChangeLogOptions | false;
  readonly limits?: LimitsOptions;
  /** Calls slower than this are logged at `warn`, in milliseconds. Default 1,000. */
  readonly slowMs?: number;
  /**
   * Replies larger than this are logged at `warn`, in bytes, and raise the
   * `oversized-response` development warning. Default 1 MiB.
   */
  readonly maxResponseBytes?: number;
  /**
   * Check every handler result against its method's contract output; a
   * mismatch fails the call with `INTERNAL`. Default: on unless `NODE_ENV`
   * is `"production"`, so always on in tests.
   */
  readonly outputValidation?: boolean;
  /** Deep-freeze the results of sharing queries. Default: on unless `NODE_ENV` is `"production"`. */
  readonly freezeSharedResults?: boolean;
  /** Receives every call's completion record. An error it throws is logged and ignored. */
  readonly onCall?: (record: CallRecord) => void;
}

/** Everything the pipeline stages read, resolved from the dispatcher's options. */
export interface PipelineSettings extends Tracking {
  readonly registry: Registry;
  readonly db: unknown;
  readonly logger: Logger;
  readonly access: AccessEngine;
  /** The services' access policies, evaluated: `dispatcher.access`. */
  readonly policies: PolicyEngine;
  readonly versions: VersionSource | undefined;
  /** Entity subscriptions, collections, their frames and revocation (RFC 0003 sections 4.4, 6 and 7). */
  readonly live: Live;
  readonly limits: DispatcherLimits;
  readonly outputValidation: boolean;
  readonly freezeSharedResults: boolean;
  /** The development warnings of this dispatcher and of the write tracker it attaches to (`../devWarnings.ts`). */
  readonly warnings: DevWarnings;
  /** Counts each connection's calls and refusals, and warns when they look like a client loop (`../devWarnings.ts`). */
  readonly loops: LoopWatch;
  readonly record: (record: CallRecord, details: RecordDetails) => void;
}

function checkCount(name: string, value: number, max: number): number {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new TypeError(`createDispatcher: ${name} must be an integer from 0 to ${max}`);
  }
  return value;
}

function resolveSubscriptionLimits(
  limits: Partial<SubscriptionLimits> | undefined,
): SubscriptionLimits {
  if (limits !== undefined && (typeof limits !== "object" || limits === null)) {
    throw new TypeError(
      "createDispatcher: limits.subscriptions must be { maxInFlight, maxQueued }",
    );
  }
  const merged = { ...DEFAULT_LIMITS.subscriptions, ...limits };
  checkCount("limits.subscriptions.maxQueued", merged.maxQueued, Number.MAX_SAFE_INTEGER);
  const inFlight = merged.maxInFlight;
  if (checkCount("limits.subscriptions.maxInFlight", inFlight, Number.MAX_SAFE_INTEGER) === 0) {
    throw new TypeError("createDispatcher: limits.subscriptions.maxInFlight must be at least 1");
  }
  return Object.freeze(merged);
}

function resolveLimits(limits: LimitsOptions = {}): DispatcherLimits {
  const subscriptions = resolveSubscriptionLimits(limits.subscriptions);
  const merged = { ...DEFAULT_LIMITS, ...limits, subscriptions };
  checkCount("limits.maxInFlightQueries", merged.maxInFlightQueries, Number.MAX_SAFE_INTEGER);
  checkCount("limits.maxQueuedQueries", merged.maxQueuedQueries, Number.MAX_SAFE_INTEGER);
  checkCount("limits.retryAfterMs", merged.retryAfterMs, MAX_TIMEOUT_MS);
  if (checkCount("limits.callTimeoutMs", merged.callTimeoutMs, MAX_TIMEOUT_MS) === 0) {
    throw new TypeError("createDispatcher: limits.callTimeoutMs must be at least 1");
  }
  if (merged.maxInFlightQueries === 0) {
    throw new TypeError("createDispatcher: limits.maxInFlightQueries must be at least 1");
  }
  return Object.freeze(merged);
}

/**
 * Applies the defaults to the dispatcher's options. `accessSinks` run right
 * after the access sink, before any frame of a flush is sent.
 */
export function resolveSettings(
  options: PipelineOptions,
  registry: Registry,
  db: unknown,
  accessSinks: readonly FlushSink[] = [],
): PipelineSettings {
  const development = process.env.NODE_ENV !== "production";
  const logger = options.logger ?? consoleLogger;
  const warnings = createDevWarnings({ logger, development, strict: strictWarningsOf(options) });
  const storage = storageFor(options, db);
  const { access, policies } = resolveAccess(options.access, registry, storage, logger);
  const live = createLive({
    registry,
    storage,
    policies,
    access,
    logger,
    changeLog: options.changeLog,
  });
  return Object.freeze({
    registry,
    db,
    logger,
    access,
    policies,
    ...resolveTracking(
      options,
      registry,
      db,
      logger,
      [live.intake, policies.sink, ...accessSinks, live.emit, live.collections, live.topics],
      live.revisions,
    ),
    versions: options.versions ?? live.versions,
    live,
    limits: resolveLimits(options.limits),
    outputValidation: options.outputValidation ?? development,
    freezeSharedResults: options.freezeSharedResults ?? development,
    warnings,
    loops: createLoopWatch(warnings, logger),
    record: createRecorder({
      logger,
      onCall: options.onCall,
      slowMs: options.slowMs ?? 1_000,
      maxResponseBytes: options.maxResponseBytes ?? 1_048_576,
      warnings,
    }),
  });
}
