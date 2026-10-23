import type { Prisma, PrismaClient } from "@project/db";

// services/shared/writers.ts: writers a service hands its Prisma client to, as
// farseer's harness writers take theirs. The service gives the first its own
// client, and the second the client of the transaction that read what it
// writes; a test's seed gives the third the app's own client as well.

/** Removes a project's members, as archiving it does. */
export async function removeProjectMembers(prisma: PrismaClient, projectId: string): Promise<void> {
  await prisma.projectMember.deleteMany({ where: { projectId } });
}

/** Writes a project's access list, inside the transaction that read it. */
export async function writeProjectAcl(
  prisma: Prisma.TransactionClient,
  id: string,
  acl: Prisma.InputJsonValue,
): Promise<void> {
  await prisma.project.update({ where: { id }, data: { acl } });
}

/** Empties a project's access list, before it is deleted and when a test seeds one. */
export async function clearProjectAcl(db: PrismaClient, id: string): Promise<void> {
  await db.project.update({ where: { id }, data: { acl: [] } });
}
