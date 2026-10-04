// The OpenTelemetry bridge (`otel.ts`, `./server/otel`): each completion
// record becomes one point per instrument, with the call's service, method,
// outcome and transport, and with a tracer one server span.

import type { Attributes, Span, SpanOptions, Tracer } from "@opentelemetry/api";
import {
  AggregationTemporality,
  DataPointType,
  MeterProvider,
  MetricReader,
  type MetricData,
} from "@opentelemetry/sdk-metrics";
import { afterEach, describe, expect, it } from "vitest";
import { alice, db, qd, task, taskDefaults } from "../__tests__/fixtures";
import { createDispatcher } from "../dispatcher";
import type { CallRecord } from "../pipeline/metrics";
import { otelOnCall, UNKNOWN_METHOD } from "./otel";

/** A reader that collects on demand, in memory. */
class TestReader extends MetricReader {
  constructor() {
    super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
  }

  protected override onForceFlush(): Promise<void> {
    return Promise.resolve();
  }

  protected override onShutdown(): Promise<void> {
    return Promise.resolve();
  }
}

const providers: MeterProvider[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map(async (provider) => await provider.shutdown()));
});

function meterWithReader() {
  const reader = new TestReader();
  const provider = new MeterProvider({ readers: [reader] });
  providers.push(provider);
  const collect = async (): Promise<Map<string, MetricData>> => {
    const { resourceMetrics, errors } = await reader.collect();
    expect(errors).toEqual([]);
    const metrics = resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
    return new Map(metrics.map((metric) => [metric.descriptor.name, metric]));
  };
  return { meter: provider.getMeter("test"), collect };
}

interface RecordedSpan {
  readonly name: string;
  readonly options: SpanOptions | undefined;
  readonly status: unknown[];
  ended: unknown;
}

function recordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const tracer = {
    startSpan(name: string, options?: SpanOptions): Span {
      const recorded: RecordedSpan = { name, options, status: [], ended: undefined };
      spans.push(recorded);
      return {
        setStatus(status: unknown) {
          recorded.status.push(status);
          return this;
        },
        end(time?: unknown) {
          recorded.ended = time;
        },
      } as unknown as Span;
    },
  } as unknown as Tracer;
  return { tracer, spans };
}

function record(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    service: "taskService",
    method: "get",
    kind: "query",
    transport: "socket",
    requestId: "req-1",
    outcome: "ok",
    durationMs: 12,
    queueMs: 1,
    bytes: 340,
    shared: false,
    sqlStatements: 2,
    ...overrides,
  };
}

const attributes: Attributes = {
  "quickdraw.service": "taskService",
  "quickdraw.method": "get",
  "quickdraw.outcome": "ok",
  "quickdraw.transport": "internal",
};

describe("otelOnCall", () => {
  it("records one point per instrument for one call through the dispatcher, with its attributes", async () => {
    const { meter, collect } = meterWithReader();
    const dispatcher = createDispatcher({
      services: [qd.defineService(task, { methods: taskDefaults })],
      db,
      onCall: otelOnCall({ meter }),
    });
    await dispatcher.caller(alice).taskService.get({ id: "t1" });
    const metrics = await collect();
    expect([...metrics.keys()].sort()).toEqual(["quickdraw.call.duration", "quickdraw.calls"]);
    const duration = metrics.get("quickdraw.call.duration");
    expect(duration?.descriptor).toMatchObject({ unit: "s" });
    expect(duration?.dataPointType).toBe(DataPointType.HISTOGRAM);
    expect(duration?.dataPoints).toHaveLength(1);
    expect(duration?.dataPoints[0]?.attributes).toEqual(attributes);
    expect(duration?.dataPoints[0]?.value).toMatchObject({ count: 1 });
    const calls = metrics.get("quickdraw.calls");
    expect(calls?.dataPointType).toBe(DataPointType.SUM);
    expect(calls?.dataPoints).toEqual([expect.objectContaining({ attributes, value: 1 })]);
  });

  it("records reply sizes and statements when the record has them, and hides unknown methods", async () => {
    const { meter, collect } = meterWithReader();
    const onCall = otelOnCall({ meter });
    onCall(record());
    onCall(
      record({
        service: "anything",
        method: "aClientMadeUp",
        kind: undefined,
        outcome: "NOT_FOUND",
        bytes: 80,
        sqlStatements: undefined,
      }),
    );
    const metrics = await collect();
    const socketAttributes = { ...attributes, "quickdraw.transport": "socket" };
    const size = metrics.get("quickdraw.call.response.size");
    expect(size?.descriptor).toMatchObject({ unit: "By" });
    expect(
      size?.dataPoints.map((point) => [point.attributes, (point.value as { sum: number }).sum]),
    ).toEqual([
      [socketAttributes, 340],
      [
        {
          "quickdraw.service": UNKNOWN_METHOD,
          "quickdraw.method": UNKNOWN_METHOD,
          "quickdraw.outcome": "NOT_FOUND",
          "quickdraw.transport": "socket",
        },
        80,
      ],
    ]);
    const statements = metrics.get("quickdraw.call.sql_statements");
    expect(
      statements?.dataPoints.map((point) => [
        point.attributes,
        (point.value as { sum: number }).sum,
      ]),
    ).toEqual([[socketAttributes, 2]]);
  });

  it("records a server span per call, lasting the call, with an error status for server faults", () => {
    const { tracer, spans } = recordingTracer();
    const onCall = otelOnCall({ tracer });
    onCall(record());
    onCall(
      record({ method: "rename", kind: "mutation", outcome: "INTERNAL", sqlStatements: undefined }),
    );
    onCall(record({ method: "rename", kind: "mutation", outcome: "FORBIDDEN" }));
    expect(spans.map((span) => [span.name, span.status])).toEqual([
      ["taskService.get", []],
      ["taskService.rename", [{ code: 2, message: "INTERNAL" }]],
      ["taskService.rename", []],
    ]);
    const [first] = spans;
    expect(first?.options).toMatchObject({
      kind: 1,
      attributes: {
        ...attributes,
        "quickdraw.transport": "socket",
        "quickdraw.request_id": "req-1",
        "quickdraw.kind": "query",
        "quickdraw.sql_statements": 2,
        "quickdraw.response.size": 340,
      },
    });
    expect((first?.ended as number) - (first?.options?.startTime as number)).toBe(12);
  });

  it("needs a meter or a tracer", () => {
    expect(() => otelOnCall({})).toThrow("otelOnCall: pass a meter, a tracer, or both");
  });
});
