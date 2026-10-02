import type { Repetition, SummaryEntry } from "./result-schema";
import { median, round } from "./stats";

/**
 * Turn each repetition into flat `name -> number` metrics and summarize them
 * across repetitions: the median is the reported number, min/max and the
 * spread show how far the repetitions disagreed.
 */

type Flat = Record<string, number | null>;

function flattenRequests(rep: Repetition, out: Flat): void {
  out["requests.failed"] = rep.failedRequests;
  for (const [event, c] of Object.entries(rep.requests)) {
    out[`requests.${event}.sent`] = c.sent;
    out[`requests.${event}.failed`] = c.timeout + c.error + c.unanswered;
    out[`requests.${event}.abandoned`] = c.abandoned;
  }
}

function flattenLatency(rep: Repetition, out: Flat): void {
  for (const [event, stats] of Object.entries(rep.latencyMs)) {
    out[`latency.${event}.p50`] = stats.p50;
    out[`latency.${event}.p95`] = stats.p95;
    out[`latency.${event}.p99`] = stats.p99;
  }
  for (const [kind, stats] of Object.entries(rep.deliveryMs)) {
    out[`delivery.${kind}.p50`] = stats.p50;
    out[`delivery.${kind}.p95`] = stats.p95;
    out[`delivery.${kind}.p99`] = stats.p99;
  }
}

function flattenServer(rep: Repetition, out: Flat): void {
  const s = rep.server;
  out["server.cpuSeconds"] = s ? round(s.cpuSeconds) : null;
  out["server.eventLoopDelayP99Ms"] = s ? round(s.eventLoopDelayMs.p99) : null;
  out["server.eventLoopDelayMaxMs"] = s ? round(s.eventLoopDelayMs.max) : null;
  out["server.bytesSentMb"] = s ? round(s.bytesSent / 1024 ** 2) : null;
  out["server.sqlStatements"] = s ? s.sqlStatements : null;
  out["server.snapshots.collection"] = s ? s.snapshotsServed.collection : null;
  out["server.snapshots.entity"] = s ? s.snapshotsServed.entity : null;
  out["server.rssPeakMb"] = s ? round(s.rssPeakMb, 1) : null;
  for (const [handler, runs] of Object.entries(s?.handlerRuns ?? {})) {
    out[`server.handlerRuns.${handler}`] = runs;
  }
}

export function flatten(rep: Repetition): Flat {
  const out: Flat = {};
  flattenLatency(rep, out);
  flattenRequests(rep, out);
  flattenServer(rep, out);
  out["loadgen.cpuSeconds"] = round(rep.loadgen.cpuSeconds);
  out["noise.otherWorkOnServerCpusPct"] = rep.noise
    ? round(rep.noise.otherWorkOnServerCpusPct, 2)
    : null;
  out["noise.restOfMachineBusyPct"] = rep.noise ? round(rep.noise.restOfMachineBusyPct, 2) : null;
  out["loadgen.eventLoopDelayP99Ms"] = round(rep.loadgen.eventLoopDelayP99Ms);
  for (const [name, value] of Object.entries(rep.scenario)) {
    out[`scenario.${name}`] = value === null ? null : round(value);
  }
  return out;
}

export function summarizeRepetitions(
  repetitions: readonly Repetition[],
): Record<string, SummaryEntry> {
  const flats = repetitions.map(flatten);
  const keys = [...new Set(flats.flatMap((flat) => Object.keys(flat)))].sort();
  const summary: Record<string, SummaryEntry> = {};
  for (const key of keys) {
    const values = flats.map((flat) => flat[key] ?? null);
    const present = values.filter((value): value is number => value !== null);
    const mid = median(values);
    const min = present.length > 0 ? Math.min(...present) : null;
    const max = present.length > 0 ? Math.max(...present) : null;
    const spread =
      mid !== null && mid !== 0 && min !== null && max !== null
        ? round(((max - min) / Math.abs(mid)) * 100, 1)
        : null;
    summary[key] = {
      values,
      median: mid === null ? null : round(mid),
      min,
      max,
      spreadPct: spread,
    };
  }
  return summary;
}
