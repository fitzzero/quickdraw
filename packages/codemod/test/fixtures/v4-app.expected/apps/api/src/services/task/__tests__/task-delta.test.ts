import type { PrismaClient } from "@project/db";
// quickdraw-migrate: review [service] TaskServiceCore was a 4.x service class of taskService; the migration turns its members into module code
import { TaskServiceCore } from "../service-core.js";

// A test's subclass of the abstract core, with none of the method modules:
// the codemod reads no service from it, and it hides nothing.
// quickdraw-migrate: review [service] TestTaskService is a 4.x service class in test code, which the codemod reads no service from (it extends taskService's classes, a service object now): test the 5.0 service through createTestApp (@fitzzero/quickdraw-core/testing), or port what this class adds
export class TestTaskService extends TaskServiceCore {
  public readonly emitted: string[] = [];

  constructor(prisma: PrismaClient) {
    super(prisma);
  }
}
