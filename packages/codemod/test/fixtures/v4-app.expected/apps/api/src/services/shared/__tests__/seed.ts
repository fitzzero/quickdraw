import { prisma } from "@project/db";
import { clearProjectAcl } from "../writers.js";

/** Seeds a project with an empty access list through the app's own client, as tests do. */
export async function seedEmptyAcl(projectId: string): Promise<void> {
  await clearProjectAcl(prisma, projectId);
}
