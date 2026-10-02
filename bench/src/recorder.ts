import { summarize, type LatencyStats } from "./stats";

/**
 * Client-side measurement. A request counts only if it was sent inside the
 * measurement window; latency samples are kept for requests answered
 * successfully within the client's timeout, and everything else is counted
 * as a failure by kind.
 */

export type FailureReason = "timeout" | "error" | "abandoned";

export type Outcome =
  | { ok: true; data: unknown }
  | { ok: false; reason: FailureReason; error?: string };

export interface RequestCounts {
  sent: number;
  succeeded: number;
  /** No answer within the client's timeout (the 4.1 hooks give up after 10 s). */
  timeout: number;
  /** The server answered `success: false`. */
  error: number;
  /** In flight when the client's own connection dropped (its ack can never arrive). */
  abandoned: number;
  /** Still unanswered when the measurement window closed (calls with no client timeout). */
  unanswered: number;
  /** Answers that arrived after the client had already timed out. */
  late: number;
}

export interface RecordedWindow {
  requests: Record<string, RequestCounts>;
  failedRequests: number;
  latencyMs: Record<string, LatencyStats>;
  deliveryMs: Record<string, LatencyStats>;
  errors: string[];
}

/** A request the recorder is tracking; `finish` and `late` are no-ops outside the window. */
export interface TrackedRequest {
  finish(outcome: Outcome, elapsedMs: number): void;
  late(): void;
}

const MAX_ERROR_SAMPLES = 10;

function emptyCounts(): RequestCounts {
  return { sent: 0, succeeded: 0, timeout: 0, error: 0, abandoned: 0, unanswered: 0, late: 0 };
}

export class Recorder {
  private active = false;
  private generation = 0;
  private counts = new Map<string, RequestCounts>();
  private latency = new Map<string, number[]>();
  private delivery = new Map<string, number[]>();
  private errors = new Set<string>();
  /** Every request in flight, recorded or not, so a scenario can wait for quiet. */
  private readonly pending = new Set<object>();

  public start(): void {
    this.generation += 1;
    this.counts = new Map();
    this.latency = new Map();
    this.delivery = new Map();
    this.errors = new Set();
    this.active = true;
  }

  public stop(): RecordedWindow {
    this.active = false;
    this.generation += 1;
    const requests = Object.fromEntries(this.counts);
    const failedRequests = [...this.counts.values()].reduce(
      (sum, c) => sum + c.timeout + c.error + c.unanswered,
      0,
    );
    return {
      requests,
      failedRequests,
      latencyMs: Object.fromEntries([...this.latency].map(([key, xs]) => [key, summarize(xs)])),
      deliveryMs: Object.fromEntries([...this.delivery].map(([key, xs]) => [key, summarize(xs)])),
      errors: [...this.errors],
    };
  }

  public get inFlight(): number {
    return this.pending.size;
  }

  public begin(key: string): TrackedRequest {
    const token = {};
    this.pending.add(token);
    const generation = this.generation;
    const counts = this.active ? this.countsFor(key) : null;
    if (counts) counts.sent += 1;
    if (counts) counts.unanswered += 1;
    let open = true;
    return {
      finish: (outcome, elapsedMs) => {
        if (!open) return;
        open = false;
        this.pending.delete(token);
        if (!counts || generation !== this.generation) return;
        counts.unanswered -= 1;
        this.count(key, counts, outcome, elapsedMs);
      },
      late: () => {
        if (counts && generation === this.generation) counts.late += 1;
      },
    };
  }

  /** Time from a writer's emit to a viewer seeing the change. */
  public deliver(kind: string, elapsedMs: number): void {
    if (!this.active) return;
    this.samples(this.delivery, kind).push(elapsedMs);
  }

  private count(key: string, counts: RequestCounts, outcome: Outcome, elapsedMs: number): void {
    if (outcome.ok) {
      counts.succeeded += 1;
      this.samples(this.latency, key).push(elapsedMs);
      return;
    }
    counts[outcome.reason] += 1;
    if (outcome.error !== undefined && this.errors.size < MAX_ERROR_SAMPLES) {
      this.errors.add(`${key}: ${outcome.error}`);
    }
  }

  private countsFor(key: string): RequestCounts {
    let counts = this.counts.get(key);
    if (!counts) {
      counts = emptyCounts();
      this.counts.set(key, counts);
    }
    return counts;
  }

  private samples(map: Map<string, number[]>, key: string): number[] {
    let list = map.get(key);
    if (!list) {
      list = [];
      map.set(key, list);
    }
    return list;
  }
}
