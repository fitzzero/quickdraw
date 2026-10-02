import { BoardState, V4Connection, Viewer, Writer } from "../drivers/v4";
import { sleep } from "../time";
import type { ScenarioContext } from "./types";

export { sleep } from "../time";

/** Pause between setup and the measured window, so connection churn has settled. */
export const SETTLE_MS = 2_000;
/** Viewers connect this many at a time during setup (setup is never measured). */
const SETUP_BATCH = 10;
const QUIET_POLL_MS = 250;

function tokenFor(ctx: ScenarioContext, userIds: readonly string[], index: number): string {
  const userId = userIds[index % userIds.length] ?? "";
  const token = ctx.tokens[userId];
  if (!token) throw new Error(`no token for ${userId}`);
  return token;
}

/**
 * Open `count` board viewers (users cycle through the Read members), each
 * subscribed to the first `entities` on-screen cards, and load their boards.
 */
export async function openViewers(
  ctx: ScenarioContext,
  count: number,
  entities: number,
): Promise<Viewer[]> {
  const entityIds = ctx.workload.hotTaskIds.slice(0, entities);
  const viewers: Viewer[] = [];
  for (let start = 0; start < count; start += SETUP_BATCH) {
    const batch = Array.from({ length: Math.min(SETUP_BATCH, count - start) }, (_, offset) => {
      const token = tokenFor(ctx, ctx.workload.viewerUserIds, start + offset);
      return new Viewer(ctx, token, ctx.workload.project.id, entityIds);
    });
    viewers.push(...batch);
    const loads = await Promise.all(batch.map(async (viewer) => await viewer.open()));
    const failed = loads.find((load) => !load.ok);
    if (failed) {
      for (const viewer of viewers) viewer.close();
      throw new Error(`a viewer failed to load during setup: ${failed.failure ?? "unknown"}`);
    }
  }
  return viewers;
}

/** Open `count` writers, one per Moderate member. */
export async function openWriters(ctx: ScenarioContext, count: number): Promise<Writer[]> {
  const board = new BoardState(ctx.workload);
  const writers = Array.from(
    { length: count },
    (_, index) => new Writer(ctx, tokenFor(ctx, ctx.workload.writerUserIds, index), index, board),
  );
  await Promise.all(writers.map(async (writer) => await writer.open()));
  return writers;
}

/** Plain authenticated connections with no subscriptions. */
export async function openConnections(
  ctx: ScenarioContext,
  count: number,
): Promise<V4Connection[]> {
  const connections = Array.from(
    { length: count },
    (_, index) => new V4Connection(ctx, tokenFor(ctx, ctx.workload.viewerUserIds, index)),
  );
  await Promise.all(connections.map(async (connection) => await connection.connect()));
  return connections;
}

export interface Quiet {
  quiet: boolean;
  ms: number;
}

/**
 * Wait until nothing is left to do: no client request in flight, no viewer
 * debounce or retry pending, and no handler running on the server.
 */
export async function waitForQuiet(
  ctx: ScenarioContext,
  viewers: readonly Viewer[],
  capMs: number,
): Promise<Quiet> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < capMs) {
    const clientIdle = ctx.recorder.inFlight === 0 && !viewers.some((viewer) => viewer.busy);
    if (clientIdle && (await ctx.serverInFlight()) === 0) {
      return { quiet: true, ms: performance.now() - startedAt };
    }
    await sleep(QUIET_POLL_MS);
  }
  return { quiet: false, ms: performance.now() - startedAt };
}

/**
 * Open-loop schedule: call `fire(i)` for i = 0..count-1 at `startAt + times[i]`,
 * without waiting for earlier calls to finish (so a slow server cannot slow
 * the offered load down). Resolves once every call has been made.
 */
export async function schedule(
  offsetsMs: readonly number[],
  fire: (index: number) => void,
): Promise<number> {
  const startAt = performance.now();
  for (const [index, offset] of offsetsMs.entries()) {
    await sleep(startAt + offset - performance.now());
    fire(index);
  }
  return performance.now() - startAt;
}

export function closeAll(clients: ReadonlyArray<{ close(): void }>): void {
  for (const client of clients) client.close();
}
