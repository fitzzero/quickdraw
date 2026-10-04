import { readFile } from "node:fs/promises";
import { createPrisma, databaseUrl } from "./db";

/**
 * Reset the database to the workload file the runner generated
 * (bench/src/workload.ts): truncate every table, insert the rows, ANALYZE.
 * Usage: node --import tsx src/seed.ts <workload.json>
 */

interface WorkloadFile {
  project: { id: string; name: string };
  users: Array<{ id: string; name: string; role: string }>;
  tasks: Array<{
    id: string;
    status: string;
    ordinal: number;
    title: string;
    assigneeId: string | null;
    plan: string;
  }>;
}

const CHUNK = 500;

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    throw new Error("usage: seed.ts <workload.json>");
  }
  const workload = JSON.parse(await readFile(path, "utf8")) as WorkloadFile;
  const prisma = createPrisma(databaseUrl());
  try {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Task", "ProjectMember", "Project", "User" RESTART IDENTITY CASCADE',
    );
    await prisma.user.createMany({
      data: workload.users.map((user) => ({ id: user.id, name: user.name })),
    });
    await prisma.project.create({ data: workload.project });
    await prisma.projectMember.createMany({
      data: workload.users.map((user) => ({
        projectId: workload.project.id,
        userId: user.id,
        role: user.role,
      })),
    });
    for (let start = 0; start < workload.tasks.length; start += CHUNK) {
      const chunk = workload.tasks.slice(start, start + CHUNK);
      await prisma.task.createMany({
        data: chunk.map((task) => ({ ...task, projectId: workload.project.id })),
      });
    }
    await prisma.$executeRawUnsafe("ANALYZE");
    process.stdout.write(
      `seeded ${workload.users.length} users, ${workload.tasks.length} tasks into ${workload.project.id}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

await main();
