import type { Outcome } from "../../recorder";
import type { BoardWriter, DriverContext } from "../types";
import type { BoardState } from "../board-state";
import { WriteSequence } from "../writes";
import { V4Connection } from "./connection";
import { CLIENT_TIMEOUT_MS, EVENTS } from "./protocol";

/**
 * A writer in the fleet: an agent or a person editing cards on the board,
 * sending the shared write sequence (`../writes.ts`) as `updateTask` events.
 */
export class Writer implements BoardWriter {
  private readonly conn: V4Connection;
  private readonly writes: WriteSequence;

  constructor(ctx: DriverContext, token: string, index: number, board: BoardState) {
    this.conn = new V4Connection(ctx, token);
    this.writes = new WriteSequence(index, board);
  }

  public async open(): Promise<void> {
    await this.conn.connect();
  }

  /** One updateTask call (useService: 10 s timeout, no retry). */
  public async write(): Promise<Outcome> {
    return await this.conn.request(EVENTS.updateTask, this.writes.next(), CLIENT_TIMEOUT_MS);
  }

  public close(): void {
    this.conn.close();
  }
}
