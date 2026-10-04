import type { PrismaClient } from "@project/db";

/** Builds a fresh label service on demand, as quickdraw-chat's definition test does. */
export async function labelsRoom(prisma: PrismaClient, projectId: string): Promise<string> {
  // quickdraw-migrate: review [server] LabelService is imported dynamically here, and 5.0 has no class: import the service object labelService (pass it in qd.createServer({ services: [...] })), or call it through qd.caller(principal)
  const { LabelService } = await import("./label.js");
  // quickdraw-migrate: review [server] the 4.x service was constructed here (new LabelService(...)): it is the object labelService now
  const labels = new LabelService(prisma);
  // quickdraw-migrate: review [server] labels is a 4.x LabelService instance, whose members (getRoomName here) the service object labelService does not have: call a contract method through qd.caller(principal).labelService.<method>(input), and move other logic into a module of its own
  return labels.getRoomName(projectId);
}
