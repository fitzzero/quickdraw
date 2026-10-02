import type { LoadResult, Viewer } from "../drivers/v4";
import { summarize } from "../stats";
import { closeAll, openViewers, SETTLE_MS, sleep, waitForQuiet, type Quiet } from "./shared";
import type { Scenario } from "./types";

type ReconnectStormParameters = {
  clients: number;
  entitySubscriptions: number;
  dropWindowSeconds: number;
  restoreCapSeconds: number;
  drainCapSeconds: number;
};

interface Restore extends LoadResult {
  /** When the board was back (or the cap hit), from the first drop. */
  doneAtMs: number;
}

async function dropAndRestore(
  viewer: Viewer,
  delayMs: number,
  capMs: number,
  t0: number,
): Promise<Restore> {
  await sleep(delayMs);
  const capped = sleep(capMs).then(
    (): LoadResult => ({ ok: false, ms: capMs, failure: "not restored within the cap" }),
  );
  const result = await Promise.race([viewer.drop(), capped]);
  return { ...result, doneAtMs: performance.now() - t0 };
}

export const reconnectStorm: Scenario<ReconnectStormParameters> = {
  name: "reconnect-storm",
  description:
    "Board viewers that are all connected drop and reconnect within two seconds, as when a " +
    "platform caps connection lifetime (Cloud Run reconnects about 190 sockets at once). Each " +
    "viewer redoes its whole board load; measured until every board is restored or the cap hits.",
  parameters: (quick) => ({
    clients: quick ? 20 : 190,
    entitySubscriptions: 60,
    dropWindowSeconds: 2,
    restoreCapSeconds: 45,
    drainCapSeconds: 15,
  }),
  async run(ctx, p) {
    const viewers = await openViewers(ctx, p.clients, p.entitySubscriptions);
    try {
      await sleep(SETTLE_MS);
      const gap = (p.dropWindowSeconds * 1_000) / p.clients;
      let restores: Restore[] = [];
      let quiet: Quiet = { quiet: false, ms: 0 };
      const measurement = await ctx.measure(async () => {
        const t0 = performance.now();
        restores = await Promise.all(
          viewers.map(
            async (viewer, index) =>
              await dropAndRestore(viewer, index * gap, p.restoreCapSeconds * 1_000, t0),
          ),
        );
        quiet = await waitForQuiet(ctx, viewers, p.drainCapSeconds * 1_000);
      });
      const restored = restores.filter((restore) => restore.ok);
      const capped = restores.filter(
        (restore) => restore.failure === "not restored within the cap",
      );
      const failed = restores.length - restored.length - capped.length;
      const times = summarize(restored.map((restore) => restore.ms));
      const lastRestore = Math.max(0, ...restored.map((restore) => restore.doneAtMs));
      return {
        measurement,
        completed: restored.length === restores.length,
        outcome:
          `${restored.length}/${restores.length} boards restored` +
          (capped.length > 0
            ? `, ${capped.length} not restored within ${p.restoreCapSeconds} s`
            : "") +
          (failed > 0 ? `, ${failed} failed (a request timed out or errored)` : "") +
          (quiet.quiet ? "" : `; server still busy ${p.drainCapSeconds} s later`),
        metrics: {
          restored: restored.length,
          notRestoredWithinCap: capped.length,
          failedRestores: failed,
          restoreP50Ms: times.p50,
          restoreP95Ms: times.p95,
          restoreP99Ms: times.p99,
          restoreMaxMs: times.max,
          lastRestoreSeconds: restored.length > 0 ? lastRestore / 1_000 : null,
        },
      };
    } finally {
      closeAll(viewers);
    }
  },
};
