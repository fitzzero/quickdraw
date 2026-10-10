import type { PrismaClient } from "@project/db";
import { TaskServiceCore } from "../service-core.js";

// A test's subclass of the abstract core, with none of the method modules:
// the codemod reads no service from it, and it hides nothing.
export class TestTaskService extends TaskServiceCore {
  public readonly emitted: string[] = [];

  constructor(prisma: PrismaClient) {
    super(prisma);
  }
}
