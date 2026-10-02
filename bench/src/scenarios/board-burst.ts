import { describeQuiet } from "./board-steady";
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

type BoardBurstParameters = {
  viewers: number;
  entitySubscriptions: number;
  writers: number;
  writes: number;
  burstSeconds: number;
  drainCapSeconds: number;
};

export const boardBurst: Scenario<BoardBurstParameters> = {
  name: "board-burst",
  description:
    "The same viewers as board-steady, then a burst of writes spread evenly over two seconds " +
    "(a bulk edit or an agent fleet landing at once); measured until every client and the server " +
    "are idle again.",
  parameters: (quick) => ({
    viewers: quick ? 10 : 50,
    entitySubscriptions: 60,
    writers: 5,
    writes: quick ? 20 : 100,
    burstSeconds: 2,
    drainCapSeconds: 45,
  }),
  async run(ctx, p) {
    const viewers = await openViewers(ctx, p.viewers, p.entitySubscriptions);
    const writers = await openWriters(ctx, p.writers);
    try {
      await sleep(SETTLE_MS);
      const gap = (p.burstSeconds * 1_000) / p.writes;
      const offsets = Array.from({ length: p.writes }, (_, index) => index * gap);
      let issueMs = 0;
      let quiet: Quiet = { quiet: false, ms: 0 };
      const measurement = await ctx.measure(async () => {
        issueMs = await schedule(offsets, (index) => {
          const writer = writers[index % writers.length];
          if (writer) void writer.write();
        });
        quiet = await waitForQuiet(ctx, viewers, p.drainCapSeconds * 1_000);
      });
      const settledMs = issueMs + quiet.ms;
      return {
        measurement,
        completed: quiet.quiet,
        outcome: `${p.writes} writes issued over ${(issueMs / 1_000).toFixed(2)} s; ${describeQuiet(quiet, p.drainCapSeconds)}`,
        metrics: {
          writesIssued: p.writes,
          issueSeconds: issueMs / 1_000,
          settleSeconds: quiet.quiet ? settledMs / 1_000 : null,
        },
      };
    } finally {
      closeAll(viewers);
      closeAll(writers);
    }
  },
};
