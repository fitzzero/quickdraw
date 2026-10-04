import { pick, type Rng } from "../prng";
import type { TaskStatus, Workload } from "../workload";

/**
 * What the writer fleet believes each on-screen card looks like, so a status
 * change is always a real move to another column. Only writers change cards,
 * and the load generator is one thread, so this view stays exact.
 */
export class BoardState {
  private readonly status = new Map<string, TaskStatus>();
  private readonly title = new Map<string, string>();

  constructor(readonly workload: Workload) {
    const hot = new Set(workload.hotTaskIds);
    for (const task of workload.tasks) {
      if (!hot.has(task.id)) continue;
      this.status.set(task.id, task.status);
      this.title.set(task.id, task.title);
    }
  }

  public baseTitle(id: string): string {
    return this.title.get(id) ?? id;
  }

  public moveTo(rng: Rng, id: string): TaskStatus {
    const current = this.status.get(id);
    const next = pick(
      rng,
      this.workload.boardStatuses.filter((status) => status !== current),
    );
    this.status.set(id, next);
    return next;
  }
}
