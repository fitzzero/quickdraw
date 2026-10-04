import { taskContract } from "bench-app-v5/contracts";
import type { Outcome } from "../../recorder";
import type { PlainConnection } from "../types";
import { timedCall } from "./client";
import { HeldConnection } from "./held";

/** An authenticated connection that only calls the board query, through the client's `call()`. */
export class V5PlainConnection extends HeldConnection implements PlainConnection {
  public async readBoard(projectId: string): Promise<Outcome> {
    return await timedCall(this.ctx.recorder, this.connection, {
      service: taskContract.name,
      method: "getTasksByStatus",
      input: { projectId },
      kind: "query",
    });
  }
}
