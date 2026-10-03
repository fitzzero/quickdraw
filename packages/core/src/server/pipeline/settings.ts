// The dispatcher's options and their defaults, resolved once into the
// settings every pipeline stage reads.

import { consoleLogger, type Logger } from "../../contract/logger";
import type { PolicyEngine } from "../access/api";
import { createBasicAccessEngine } from "../access/basicEngine";
import { createPolicyEngine, type AccessOptions } from "../access/engine";
import type { AccessEngine } from "../access/types";
import type { Registry } from "../registry";
import { storageOf } from "../storage";
import { createRecorder, type CallRecord, type RecordDetails } from "./metrics";
import type { VersionSource } from "./notModified";
import { resolveTracking, type Tracking, type TrackingOptions } from "./tracking";

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
}

/** The defaults of RFC 0003 section 9. */
export const DEFAULT_LIMITS: DispatcherLimits = Object.freeze({
  maxInFlightQueries: 16,
  maxQueuedQueries: 64,
  callTimeoutMs: 30_000,
  retryAfterMs: 1_000,
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
  /** Answers query versions for "not modified" replies. Default: none. */
  readonly versions?: VersionSource;
  readonly limits?: Partial<DispatcherLimits>;
  /** Calls slower than this are logged at `warn`, in milliseconds. Default 1,000. */
  readonly slowMs?: number;
  /** Replies larger than this are logged at `warn`, in bytes. Default 1 MiB. */
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
  readonly limits: DispatcherLimits;
  readonly outputValidation: boolean;
  readonly freezeSharedResults: boolean;
  readonly record: (record: CallRecord, details: RecordDetails) => void;
}

function checkCount(name: string, value: number, max: number): number {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new TypeError(`createDispatcher: ${name} must be an integer from 0 to ${max}`);
  }
  return value;
}

function resolveLimits(limits: Partial<DispatcherLimits> = {}): DispatcherLimits {
  const merged = { ...DEFAULT_LIMITS, ...limits };
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

function isAccessEngine(value: unknown): value is AccessEngine {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<AccessEngine>).authorize === "function"
  );
}

/** The policy engine, and the access engine: the app's own, or the basic engine with the policies' row access. */
function resolveAccess(
  options: PipelineOptions,
  registry: Registry,
  db: unknown,
  logger: Logger,
): { access: AccessEngine; policies: PolicyEngine } {
  const { access } = options;
  if (access !== undefined && (typeof access !== "object" || access === null)) {
    throw new TypeError("createDispatcher: access must be an access engine or { cacheMs }");
  }
  const engine = isAccessEngine(access) ? access : undefined;
  const accessOptions: AccessOptions = isAccessEngine(access) ? {} : (access ?? {});
  const policies = createPolicyEngine({
    registry,
    storage: options.storage ?? storageOf(db),
    logger,
    cacheMs: accessOptions.cacheMs,
  });
  return { access: engine ?? createBasicAccessEngine({ rows: policies.rows }), policies };
}

/** Applies the defaults to the dispatcher's options. */
export function resolveSettings(
  options: PipelineOptions,
  registry: Registry,
  db: unknown,
): PipelineSettings {
  const development = process.env.NODE_ENV !== "production";
  const logger = options.logger ?? consoleLogger;
  const { access, policies } = resolveAccess(options, registry, db, logger);
  return Object.freeze({
    registry,
    db,
    logger,
    access,
    policies,
    ...resolveTracking(options, registry, db, logger, policies.sink),
    versions: options.versions,
    limits: resolveLimits(options.limits),
    outputValidation: options.outputValidation ?? development,
    freezeSharedResults: options.freezeSharedResults ?? development,
    record: createRecorder({
      logger,
      onCall: options.onCall,
      slowMs: options.slowMs ?? 1_000,
      maxResponseBytes: options.maxResponseBytes ?? 1_048_576,
    }),
  });
}
