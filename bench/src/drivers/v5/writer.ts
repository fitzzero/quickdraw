import { taskContract } from "bench-app-v5/contracts";
import type { Outcome } from "../../recorder";
import type { BoardState } from "../board-state";
import type { BoardWriter, DriverContext } from "../types";
import { WriteSequence } from "../writes";
import { timedCall } from "./client";
import { HeldConnection } from "./held";

/**
 * A writer in the fleet, sending the shared write sequence (`../writes.ts`)
 * as `qd.task.updateTask.useMutation()` sends it: a mutation call with the
 * client's default time limit (the server's `callTimeoutMs` plus 2 s) and no
 * retry. The optimistic layer the hook adds lives in the client's cache only.
 */
export class V5Writer extends HeldConnection implements BoardWriter {
  private readonly writes: WriteSequence;

  constructor(ctx: DriverContext, token: string, index: number, board: BoardState) {
    super(ctx, token);
    this.writes = new WriteSequence(index, board);
  }

  public async open(): Promise<void> {
    await this.connect();
  }

  public async write(): Promise<Outcome> {
    return await timedCall(this.ctx.recorder, this.connection, {
      service: taskContract.name,
      method: "updateTask",
      input: this.writes.next(),
      kind: "mutation",
    });
  }
}
