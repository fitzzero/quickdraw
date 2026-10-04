// The README's tracked-writes examples: writes outside a method call.

import { db } from "../db";
import { qd } from "../quickdraw";

// #region run
export async function markStale(before: Date): Promise<number> {
  // a job's writes flush to subscribers when qd.run settles, as a method's do
  const { count } = await qd.run(() =>
    db.task.updateMany({
      where: { status: "open", updatedAt: { lt: before } },
      data: { status: "stale" },
    }),
  );
  return count;
}
// #endregion

// #region touch
export async function spreadOrdinals(projectId: string): Promise<void> {
  await qd.run(async (ctx) => {
    const rows = await db.$queryRaw<{ id: string }[]>`
      UPDATE "Task" SET "ordinal" = "ordinal" * 2 WHERE "projectId" = ${projectId} RETURNING "id"`;
    // raw SQL is invisible to the tracked client: record the rows it changed
    ctx.touch(
      "task",
      rows.map((row) => row.id),
    );
  });
}
// #endregion
