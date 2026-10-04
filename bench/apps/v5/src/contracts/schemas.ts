import { z } from "zod";

// The wire shapes of the benchmark board, the same rows the 4.1 app serves
// (prisma/schema.prisma). Dates travel as ISO strings.

/** Board columns, in order; Cancelled cards are never shown. */
export const BOARD_STATUSES = [
  "Planning",
  "Open",
  "InProgress",
  "ReviewPR",
  "ReviewDev",
  "Complete",
] as const;

/** Every status a task can have. */
export const TASK_STATUSES = [...BOARD_STATUSES, "Cancelled"] as const;

/** Cards per column on the first board load (Conveyor's board uses 20). */
export const BOARD_PAGE_SIZE = 20;

export const projectSchema = z.object({ id: z.string(), name: z.string() });

/** The full task, with its 4 KB `plan`: what an entity subscription and the board query send. */
export const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  status: z.string(),
  ordinal: z.number(),
  title: z.string(),
  assigneeId: z.string().nullable(),
  plan: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** What a card on the board needs: the task without its plan. */
export const cardSchema = taskSchema.pick({
  id: true,
  projectId: true,
  status: true,
  ordinal: true,
  title: true,
  assigneeId: true,
  updatedAt: true,
});

/** One board column: its first cards, as full rows, and how many cards it has. */
export const columnSchema = z.object({
  status: z.string(),
  tasks: z.array(taskSchema),
  totalCount: z.number().int(),
});

/** The fields a writer may change. */
export const taskChangesSchema = z.object({
  title: z.string().min(1).max(500),
  status: z.enum(TASK_STATUSES),
  ordinal: z.number().int().min(0),
  assigneeId: z.string().nullable(),
});
