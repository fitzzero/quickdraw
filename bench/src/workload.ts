import { createRng, pick, randomInt, type Rng } from "./prng";

/**
 * The benchmark board, generated deterministically. Every app under
 * `bench/apps/` seeds its database from this file, so a 4.1 run and a later
 * 5.0 run read identical rows.
 */

export const WORKLOAD_VERSION = 1;
export const PROJECT_ID = "bench-project";

/** Every status a task can have, in board order. */
export const TASK_STATUSES = [
  "Planning",
  "Open",
  "InProgress",
  "ReviewPR",
  "ReviewDev",
  "Complete",
  "Cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** The columns `getTasksByStatus` returns (everything but Cancelled). */
export const BOARD_STATUSES: readonly TaskStatus[] = TASK_STATUSES.filter((s) => s !== "Cancelled");

/** Rows per status: 2,000 tasks, most of them finished, as on a long-lived board. */
const STATUS_COUNTS: Record<TaskStatus, number> = {
  Planning: 200,
  Open: 300,
  InProgress: 120,
  ReviewPR: 80,
  ReviewDev: 60,
  Complete: 1140,
  Cancelled: 100,
};

/** The first rows of each board column are the cards on screen: the "hot" set. */
const HOT_PER_COLUMN = 10;
const ORDINAL_STEP = 1024;
const MEMBER_COUNT = 60;
/** Members 0-9 may edit (Moderate); 10-59 only view (Read). */
const WRITER_MEMBERS = 10;
const PLAN_BYTES = 4096;
const SEED = 0x5eed;

export interface WorkloadUser {
  id: string;
  name: string;
  role: "Read" | "Moderate";
}

export interface WorkloadTask {
  id: string;
  status: TaskStatus;
  ordinal: number;
  title: string;
  assigneeId: string | null;
  plan: string;
}

export interface Workload {
  version: number;
  project: { id: string; name: string };
  users: WorkloadUser[];
  tasks: WorkloadTask[];
  /** The 60 cards every viewer subscribes to and every writer edits. */
  hotTaskIds: string[];
  writerUserIds: string[];
  viewerUserIds: string[];
  statuses: readonly TaskStatus[];
  boardStatuses: readonly TaskStatus[];
  ordinalStep: number;
}

const WORDS = [
  "agent",
  "board",
  "branch",
  "build",
  "cache",
  "card",
  "change",
  "channel",
  "client",
  "collection",
  "column",
  "commit",
  "config",
  "contract",
  "cursor",
  "database",
  "delta",
  "deploy",
  "design",
  "emit",
  "entity",
  "error",
  "event",
  "field",
  "fix",
  "flag",
  "gate",
  "handler",
  "index",
  "invalidate",
  "limit",
  "lint",
  "member",
  "merge",
  "method",
  "metric",
  "migration",
  "module",
  "pack",
  "page",
  "payload",
  "plan",
  "policy",
  "project",
  "query",
  "reconnect",
  "release",
  "review",
  "revision",
  "room",
  "row",
  "schema",
  "scope",
  "server",
  "service",
  "session",
  "snapshot",
  "socket",
  "status",
  "subscribe",
  "task",
  "test",
  "timeout",
  "token",
  "update",
  "user",
  "view",
  "worker",
  "write",
];

const HEADINGS = ["Objective", "Approach", "Implementation steps", "Testing", "Notes", "Risks"];

function sentence(rng: Rng): string {
  const length = 8 + randomInt(rng, 10);
  const words = Array.from({ length }, () => pick(rng, WORDS));
  const first = words[0] ?? "the";
  words[0] = first.charAt(0).toUpperCase() + first.slice(1);
  return `${words.join(" ")}.`;
}

/** About 4 KB of markdown-like text, unique per task. */
export function planText(rng: Rng, bytes = PLAN_BYTES): string {
  let text = "";
  let heading = 0;
  while (text.length < bytes) {
    text += `## ${HEADINGS[heading % HEADINGS.length] ?? "Notes"}\n\n`;
    heading += 1;
    const sentences = 3 + randomInt(rng, 4);
    text += `${Array.from({ length: sentences }, () => sentence(rng)).join(" ")}\n\n`;
  }
  return text.slice(0, bytes);
}

function buildUsers(): WorkloadUser[] {
  return Array.from({ length: MEMBER_COUNT }, (_, index) => {
    const suffix = String(index).padStart(2, "0");
    return {
      id: `user-${suffix}`,
      name: `Bench user ${suffix}`,
      role: index < WRITER_MEMBERS ? "Moderate" : "Read",
    };
  });
}

function buildTasks(rng: Rng, users: WorkloadUser[]): { tasks: WorkloadTask[]; hot: string[] } {
  const tasks: WorkloadTask[] = [];
  const hot: string[] = [];
  for (const status of TASK_STATUSES) {
    for (let position = 0; position < STATUS_COUNTS[status]; position += 1) {
      const number = tasks.length;
      const id = `task-${String(number).padStart(4, "0")}`;
      const assignee = number % 7 === 0 ? null : (users[number % users.length]?.id ?? null);
      tasks.push({
        id,
        status,
        ordinal: position * ORDINAL_STEP,
        title: `Card ${number}: ${sentence(rng).slice(0, 48)}`,
        assigneeId: assignee,
        plan: planText(rng),
      });
      if (BOARD_STATUSES.includes(status) && position < HOT_PER_COLUMN) {
        hot.push(id);
      }
    }
  }
  return { tasks, hot };
}

export function buildWorkload(): Workload {
  const rng = createRng(SEED);
  const users = buildUsers();
  const { tasks, hot } = buildTasks(rng, users);
  return {
    version: WORKLOAD_VERSION,
    project: { id: PROJECT_ID, name: "Benchmark board" },
    users,
    tasks,
    hotTaskIds: hot,
    writerUserIds: users.filter((u) => u.role === "Moderate").map((u) => u.id),
    viewerUserIds: users.filter((u) => u.role === "Read").map((u) => u.id),
    statuses: TASK_STATUSES,
    boardStatuses: BOARD_STATUSES,
    ordinalStep: ORDINAL_STEP,
  };
}

/** Counts that describe the workload in a result file. */
export function describeWorkload(workload: Workload): Record<string, number> {
  const planBytes = workload.tasks.reduce((sum, task) => sum + task.plan.length, 0);
  return {
    tasks: workload.tasks.length,
    members: workload.users.length,
    writerMembers: workload.writerUserIds.length,
    viewerMembers: workload.viewerUserIds.length,
    hotTasks: workload.hotTaskIds.length,
    boardColumns: workload.boardStatuses.length,
    meanPlanBytes: Math.round(planBytes / workload.tasks.length),
  };
}
