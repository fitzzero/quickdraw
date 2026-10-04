// The OpenTelemetry bridge, `@fitzzero/quickdraw-core/server/otel`: an
// `onCall` handler that turns each call's completion record (RFC 0003
// section 9, step 9) into metrics and, given a tracer, a span. It is its own
// entry so `./server` never imports `@opentelemetry/api`, an optional peer
// dependency that only an app passing a meter or a tracer needs.
//
//   import { metrics, trace } from "@opentelemetry/api";
//   import { otelOnCall } from "@fitzzero/quickdraw-core/server/otel";
//
//   qd.createServer({
//     ...options,
//     onCall: otelOnCall({ meter: metrics.getMeter("api"), tracer: trace.getTracer("api") }),
//   });
//
// | Instrument                      | Kind      | Unit          | Recorded                       |
// |---------------------------------|-----------|---------------|--------------------------------|
// | `quickdraw.calls`               | counter   | `{call}`      | every call                     |
// | `quickdraw.call.duration`       | histogram | `s`           | every call                     |
// | `quickdraw.call.response.size`  | histogram | `By`          | a reply the transport measured |
// | `quickdraw.call.sql_statements` | histogram | `{statement}` | a call that ran its handler    |
//
// Every point carries `quickdraw.service`, `quickdraw.method`,
// `quickdraw.outcome` (`ok`, `not-modified` or the error code) and
// `quickdraw.transport`. A call to a method that does not exist names it
// from the client's frame, so it is recorded as service and method
// `_unknown`: no client can add attribute values.

import {
  SpanKind,
  SpanStatusCode,
  type Attributes,
  type Meter,
  type Tracer,
} from "@opentelemetry/api";
import type { CallRecord } from "../pipeline/metrics";

/** Options of {@link otelOnCall}: a meter, a tracer, or both. */
export interface OtelOnCallOptions {
  /** Records the instruments in the table above. */
  readonly meter?: Meter;
  /**
   * Records one server span per call, `{service}.{method}`, ending as its
   * record is emitted and lasting the call's `durationMs`; `INTERNAL` and
   * `TIMEOUT` outcomes set an error status.
   */
  readonly tracer?: Tracer;
}

/** The service and method a point is recorded under for a method that does not exist. */
export const UNKNOWN_METHOD = "_unknown";

/** Duration buckets, in seconds: OpenTelemetry's advice for request durations. */
const DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
];

/** Reply size buckets, in bytes, up to the default `maxResponseBytes` and past it. */
const SIZE_BUCKETS = [128, 512, 2048, 8192, 32_768, 131_072, 524_288, 1_048_576, 4_194_304];

const STATEMENT_BUCKETS = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 100];

function attributesOf(record: CallRecord): Attributes {
  const known = record.kind !== undefined;
  return {
    "quickdraw.service": known ? record.service : UNKNOWN_METHOD,
    "quickdraw.method": known ? record.method : UNKNOWN_METHOD,
    "quickdraw.outcome": record.outcome,
    "quickdraw.transport": record.transport,
  };
}

function metricsOn(meter: Meter): (record: CallRecord, attributes: Attributes) => void {
  const calls = meter.createCounter("quickdraw.calls", {
    description: "Method calls, by service, method, outcome and transport",
    unit: "{call}",
  });
  const duration = meter.createHistogram("quickdraw.call.duration", {
    description: "From a call's arrival until its result was ready",
    unit: "s",
    advice: { explicitBucketBoundaries: DURATION_BUCKETS },
  });
  const size = meter.createHistogram("quickdraw.call.response.size", {
    description: "The size of a call's reply as its transport sent it",
    unit: "By",
    advice: { explicitBucketBoundaries: SIZE_BUCKETS },
  });
  const statements = meter.createHistogram("quickdraw.call.sql_statements", {
    description:
      "Database statements a call's handler ran (access checks and flushes not included)",
    unit: "{statement}",
    advice: { explicitBucketBoundaries: STATEMENT_BUCKETS },
  });
  return (record, attributes) => {
    calls.add(1, attributes);
    duration.record(record.durationMs / 1000, attributes);
    if (record.bytes > 0) {
      size.record(record.bytes, attributes);
    }
    if (record.sqlStatements !== undefined) {
      statements.record(record.sqlStatements, attributes);
    }
  };
}

function spansOn(tracer: Tracer): (record: CallRecord, attributes: Attributes) => void {
  return (record, attributes) => {
    const endTime = Date.now();
    const known = record.kind !== undefined;
    const span = tracer.startSpan(
      known ? `${record.service}.${record.method}` : `${UNKNOWN_METHOD}.${UNKNOWN_METHOD}`,
      {
        kind: SpanKind.SERVER,
        startTime: endTime - record.durationMs,
        attributes: {
          ...attributes,
          "quickdraw.request_id": record.requestId,
          "quickdraw.shared": record.shared,
          "quickdraw.queue_ms": record.queueMs,
          "quickdraw.response.size": record.bytes,
          ...(record.kind === undefined ? {} : { "quickdraw.kind": record.kind }),
          ...(record.sqlStatements === undefined
            ? {}
            : { "quickdraw.sql_statements": record.sqlStatements }),
        },
      },
    );
    if (record.outcome === "INTERNAL" || record.outcome === "TIMEOUT") {
      span.setStatus({ code: SpanStatusCode.ERROR, message: record.outcome });
    }
    span.end(endTime);
  };
}

/**
 * An `onCall` handler (for `createServer` or `createDispatcher`) that records
 * each call with OpenTelemetry: the `quickdraw.*` instruments on `meter`,
 * and a span per call on `tracer`. The instruments are created once, here.
 *
 * @example
 * const server = qd.createServer({ app, services, db, onCall: otelOnCall({ meter, tracer }) });
 */
export function otelOnCall(options: OtelOnCallOptions): (record: CallRecord) => void {
  const { meter, tracer } = options;
  if (meter === undefined && tracer === undefined) {
    throw new TypeError("otelOnCall: pass a meter, a tracer, or both");
  }
  const recordMetrics = meter === undefined ? undefined : metricsOn(meter);
  const recordSpan = tracer === undefined ? undefined : spansOn(tracer);
  return (record) => {
    const attributes = attributesOf(record);
    recordMetrics?.(record, attributes);
    recordSpan?.(record, attributes);
  };
}
