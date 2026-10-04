import type { PrismaClient } from "@project/db";

/** Builds a fresh label service on demand, as quickdraw-chat's definition test does. */
export async function labelsRoom(prisma: PrismaClient, projectId: string): Promise<string> {
  const { LabelService } = await import("./label.js");
  const labels = new LabelService(prisma);
  return labels.getRoomName(projectId);
}
