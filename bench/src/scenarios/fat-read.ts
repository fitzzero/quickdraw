import { summarize } from "../stats";
import { closeAll, openConnections, SETTLE_MS, sleep, waitForQuiet, type Quiet } from "./shared";
import type { Scenario } from "./types";

type FatReadParameters = {
  clients: number;
  rounds: number;
  roundGapMs: number;
  drainCapSeconds: number;
};

export const fatRead: Scenario<FatReadParameters> = {
  name: "fat-read",
  description:
    "Clients issue the same getTasksByStatus call (full rows, about 4 KB each) in the same tick, " +
    "round after round: what the server pays for identical concurrent reads (4.1 runs each one; 5.0 " +
    "can share them).",
  parameters: (quick) => ({
    clients: quick ? 5 : 20,
    rounds: quick ? 3 : 10,
    roundGapMs: 500,
    drainCapSeconds: 15,
  }),
  async run(ctx, p) {
    const connections = await openConnections(ctx, p.clients);
    try {
      await sleep(SETTLE_MS);
      const roundMs: number[] = [];
      let failedRounds = 0;
      let quiet: Quiet = { quiet: false, ms: 0 };
      const projectId = ctx.workload.project.id;
      const measurement = await ctx.measure(async () => {
        for (let round = 0; round < p.rounds; round += 1) {
          const startedAt = performance.now();
          const outcomes = await Promise.all(
            connections.map(async (connection) => await connection.readBoard(projectId)),
          );
          roundMs.push(performance.now() - startedAt);
          if (outcomes.some((outcome) => !outcome.ok)) failedRounds += 1;
          await sleep(p.roundGapMs);
        }
        quiet = await waitForQuiet(ctx, [], p.drainCapSeconds * 1_000);
      });
      const rounds = summarize(roundMs);
      return {
        measurement,
        completed: failedRounds === 0,
        outcome:
          `${p.rounds} rounds of ${p.clients} identical calls; ` +
          (failedRounds === 0 ? "every call answered" : `${failedRounds} rounds had a failed call`),
        metrics: {
          roundP50Ms: rounds.p50,
          roundMaxMs: rounds.max,
          firstRoundMs: roundMs[0] ?? null,
          lastRoundMs: roundMs.at(-1) ?? null,
          failedRounds,
          drainSeconds: quiet.quiet ? quiet.ms / 1_000 : null,
        },
      };
    } finally {
      closeAll(connections);
    }
  },
};
