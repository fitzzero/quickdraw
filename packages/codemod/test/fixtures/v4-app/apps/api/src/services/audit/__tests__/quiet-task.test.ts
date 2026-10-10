import type { PrismaClient } from "@project/db";
import { TaskService } from "../../task/index.js";

// A test's subclass of the real service, in a directory that sorts before
// services/task: the codemod still reads taskService from TaskService.
export class QuietTaskService extends TaskService {
  constructor(prisma: PrismaClient) {
    super(prisma);
  }
}

export function quietTasks(prisma: PrismaClient): QuietTaskService {
  return new QuietTaskService(prisma);
}
