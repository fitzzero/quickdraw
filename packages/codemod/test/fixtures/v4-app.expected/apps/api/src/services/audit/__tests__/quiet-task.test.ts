import type { PrismaClient } from "@project/db";
// A test's subclass of the real service, in a directory that sorts before
// services/task: the codemod still reads taskService from TaskService.
// quickdraw-migrate: review [service] QuietTaskService is a 4.x service class in test code, which the codemod reads no service from (it extends taskService's classes, a service object now): test the 5.0 service through createTestApp (@fitzzero/quickdraw-core/testing), or port what this class adds
// quickdraw-migrate: review [server] TaskService was the 4.x service class; the service is the object taskService now
export class QuietTaskService extends TaskService {
  constructor(prisma: PrismaClient) {
    super(prisma);
  }
}

export function quietTasks(prisma: PrismaClient): QuietTaskService {
  return new QuietTaskService(prisma);
}
