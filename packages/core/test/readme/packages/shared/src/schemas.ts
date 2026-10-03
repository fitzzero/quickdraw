import { z } from "zod";

export const projectSchema = z.object({ id: z.string(), name: z.string(), ownerId: z.string() });

export const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  status: z.string(),
  ordinal: z.number(),
  assigneeId: z.string().nullable(),
  notes: z.string().nullable(),
});

/** The lean shape a board shows. */
export const cardSchema = taskSchema.omit({ notes: true });
