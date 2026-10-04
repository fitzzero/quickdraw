import { createRng, pick, randomInt, type Rng } from "../prng";
import type { TaskStatus } from "../workload";
import type { BoardState } from "./board-state";

/**
 * The writes every target receives. A writer's sequence depends only on its
 * index and the workload, so a 4.1 run and a 5.0 run issue the same writes
 * in the same order, whatever client sends them.
 */

/** Writers stamp every title with `@<performance.now()>` so viewers can time delivery. */
export function stampTitle(base: string, tag: string, stampMs: number): string {
  return `${base} · ${tag} @${stampMs.toFixed(3)}`;
}

export function readStamp(title: unknown): number | null {
  if (typeof title !== "string") return null;
  const match = /@(\d+(?:\.\d+)?)$/.exec(title);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** Share of writes that move a card, reorder it, or reassign it; the rest edit only the title. */
const MOVE = 0.35;
const REORDER = 0.6;
const REASSIGN = 0.75;
/** Reorders land among the first 30 slots of a column, where the board shows them. */
const REORDER_SLOTS = 30;

/** One `updateTask` input. */
export interface TaskWrite {
  id: string;
  title: string;
  status?: TaskStatus;
  ordinal?: number;
  assigneeId?: string | null;
}

/**
 * One writer's deterministic sequence: each write picks one of the 60
 * on-screen cards and changes its title plus, most of the time, its column,
 * its position or its assignee.
 */
export class WriteSequence {
  private readonly rng: Rng;
  private sequence = 0;

  constructor(
    private readonly index: number,
    private readonly board: BoardState,
  ) {
    this.rng = createRng(1_000 + index);
  }

  /** The next write, its title stamped with the time it is made. */
  public next(): TaskWrite {
    this.sequence += 1;
    const id = pick(this.rng, this.board.workload.hotTaskIds);
    const change = this.change(id);
    const title = stampTitle(
      this.board.baseTitle(id),
      `w${this.index}#${this.sequence}`,
      performance.now(),
    );
    return { id, ...change, title };
  }

  private change(id: string): Omit<TaskWrite, "id" | "title"> {
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
