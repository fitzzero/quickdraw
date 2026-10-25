// `inKitTransaction` (`transactions.ts`): what a kit asks of its transaction
// reaches the database client's `$transaction` as Prisma names it. The admin
// kit's tests run a time limit against the database.

import { describe, expect, it } from "vitest";
import { inKitTransaction } from "./transactions";

/** A client whose `$transaction` runs the callback, recording the options it was given. */
function recordingClient() {
  const options: unknown[][] = [];
  const db = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>, ...given: unknown[]) => {
      options.push(given);
      return await callback("tx");
    },
  };
  return { db, options };
}

describe("inKitTransaction", () => {
  it("gives $transaction the time limits and the isolation a kit asks for, and nothing when it asks none", async () => {
    const { db, options } = recordingClient();
    expect(
      await inKitTransaction(db, async (tx) => await Promise.resolve(tx), { owner: "A kit" }),
    ).toBe("tx");
    await inKitTransaction(db, async () => await Promise.resolve(), {
      owner: "A kit",
      timeoutMs: 30_000,
      maxWaitMs: 4_000,
    });
    await inKitTransaction(db, async () => await Promise.resolve(), {
      owner: "A kit",
      conflict: "Changed meanwhile",
    });
    expect(options).toEqual([
      [],
      [{ timeout: 30_000, maxWait: 4_000 }],
      [{ isolationLevel: "Serializable" }],
    ]);
  });
});
