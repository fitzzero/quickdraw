import { createRng, pick, randomInt, type Rng } from "../../prng";
import type { Outcome } from "../../recorder";
import type { BoardState } from "./board-state";
import { V4Connection, type DriverContext } from "./connection";
import { CLIENT_TIMEOUT_MS, EVENTS, stampTitle } from "./protocol";

/**
 * A writer in the fleet: an agent or a person editing cards on the board.
 * Each write picks one of the 60 on-screen cards and changes its title plus,
 * most of the time, its column, its position or its assignee. Writes are
 * deterministic per writer index, so every run issues the same sequence.
 */

/** Share of writes that move a card, reorder it, or reassign it; the rest edit only the title. */
const MOVE = 0.35;
const REORDER = 0.6;
const REASSIGN = 0.75;
/** Reorders land among the first 30 slots of a column, where the board shows them. */
const REORDER_SLOTS = 30;

export class Writer {
  private readonly conn: V4Connection;
  private readonly rng: Rng;
  private sequence = 0;

  constructor(
    ctx: DriverContext,
    token: string,
    private readonly index: number,
    private readonly board: BoardState,
  ) {
    this.conn = new V4Connection(ctx, token);
    this.rng = createRng(1_000 + index);
  }

  public async open(): Promise<void> {
    await this.conn.connect();
  }

  /** One updateTask call (useService: 10 s timeout, no retry). */
  public async write(): Promise<Outcome> {
    this.sequence += 1;
    const id = pick(this.rng, this.board.workload.hotTaskIds);
    const change = this.change(id);
    const title = stampTitle(
      this.board.baseTitle(id),
      `w${this.index}#${this.sequence}`,
      performance.now(),
    );
    return await this.conn.request(EVENTS.updateTask, { id, ...change, title }, CLIENT_TIMEOUT_MS);
  }

  public close(): void {
    this.conn.close();
  }

  private change(id: string): Record<string, unknown> {
    const roll = this.rng();
    if (roll < MOVE) return { status: this.board.moveTo(this.rng, id) };
    if (roll < REORDER) {
      const step = this.board.workload.ordinalStep;
      return { ordinal: randomInt(this.rng, REORDER_SLOTS) * step + randomInt(this.rng, step) };
    }
    if (roll < REASSIGN) {
      const users = this.board.workload.users;
      return { assigneeId: this.rng() < 0.1 ? null : pick(this.rng, users).id };
    }
    return {};
  }
}
