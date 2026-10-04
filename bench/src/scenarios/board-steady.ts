import {
  closeAll,
  openViewers,
  openWriters,
  schedule,
  SETTLE_MS,
  sleep,
  waitForQuiet,
  type Quiet,
} from "./shared";
import type { Scenario } from "./types";

type BoardSteadyParameters = {
  viewers: number;
  entitySubscriptions: number;
  writers: number;
  writesPerSecondPerWriter: number;
  durationSeconds: number;
  drainCapSeconds: number;
};

/** Write times for an open-loop fleet: writer k fires every 1/rate s, offset by k/(writers·rate). */
export function steadyWrites(p: BoardSteadyParameters): Array<{ at: number; writer: number }> {
  const interval = 1_000 / p.writesPerSecondPerWriter;
  const writes: Array<{ at: number; writer: number }> = [];
  for (let writer = 0; writer < p.writers; writer += 1) {
    const offset = (writer * interval) / p.writers;
    for (let at = offset; at < p.durationSeconds * 1_000; at += interval) {
      writes.push({ at, writer });
    }
  }
  return writes.sort((a, b) => a.at - b.at);
}

export function describeQuiet(quiet: Quiet, capSeconds: number): string {
  return quiet.quiet
    ? `server and clients idle ${(quiet.ms / 1_000).toFixed(1)} s after the load ended`
    : `still busy ${capSeconds} s after the load ended (cap reached)`;
}

export const boardSteady: Scenario<BoardSteadyParameters> = {
  name: "board-steady",
  description:
    "Viewers hold the board open (the cardsByProject collection, 60 entity subscriptions and a " +
    "getTasksByStatus query fetched again whenever the board changes) while a writer fleet edits the " +
    "on-screen cards at a steady rate.",
  parameters: (quick) => ({
    viewers: quick ? 10 : 50,
    entitySubscriptions: 60,
    writers: 5,
    writesPerSecondPerWriter: 2,
    durationSeconds: quick ? 10 : 60,
    drainCapSeconds: 30,
  }),
  async run(ctx, p) {
    const viewers = await openViewers(ctx, p.viewers, p.entitySubscriptions);
    const writers = await openWriters(ctx, p.writers);
    try {
      await sleep(SETTLE_MS);
      const writes = steadyWrites(p);
      let issueMs = 0;
      let quiet: Quiet = { quiet: false, ms: 0 };
      const measurement = await ctx.measure(async () => {
        issueMs = await schedule(
          writes.map((write) => write.at),
          (index) => {
            const writer = writers[writes[index]?.writer ?? 0];
            if (writer) void writer.write();
          },
        );
        quiet = await waitForQuiet(ctx, viewers, p.drainCapSeconds * 1_000);
      });
      return {
        measurement,
        completed: quiet.quiet,
        outcome: `${writes.length} writes issued over ${(issueMs / 1_000).toFixed(1)} s; ${describeQuiet(quiet, p.drainCapSeconds)}`,
        metrics: {
          writesIssued: writes.length,
          issueSeconds: issueMs / 1_000,
          drainSeconds: quiet.quiet ? quiet.ms / 1_000 : null,
        },
      };
    } finally {
      closeAll(viewers);
      closeAll(writers);
    }
  },
};
