import { JOB, ROUTE, SERVICE, SERVICE_TEST, run } from "./tester.mjs";

run("no-untracked-write", {
  valid: [
    {
      name: "handlers write through their db argument (the e2e fixture app's task service)",
      filename: SERVICE,
      code: `
        import { QuickdrawError } from "@fitzzero/quickdraw-core";
        import { inherit } from "@fitzzero/quickdraw-core/server";
        import { qd } from "../quickdraw";

        export const taskService = qd.defineService(taskContract, {
          model: "task",
          access: inherit({ from: projectContract, via: "projectId" }),
          methods: {
            create: {
              access: { scope: "Moderate", of: projectContract, id: "projectId" },
              handler: ({ input, db }) => db.task.create({ data: input }),
            },
            rename: {
              access: { entry: "Moderate" },
              handler: async ({ input, db }) => {
                if (input.title === "conflict") {
                  throw new QuickdrawError("CONFLICT", "That title is taken");
                }
                return await db.task.update({ where: { id: input.id }, data: { title: input.title } });
              },
            },
            remove: {
              access: { entry: "Moderate" },
              handler: async ({ input, db }) => {
                await db.task.delete({ where: { id: input.id } });
                return null;
              },
            },
          },
        });
      `,
    },
    {
      name: "a job writes through the tracked client inside qd.run (README)",
      filename: JOB,
      code: `
        import { db } from "../db";
        import { qd } from "../quickdraw";

        export async function markLate(now: Date): Promise<void> {
          await qd.run(() => db.task.updateMany({ where: { dueAt: { lt: now } }, data: { late: true } }));
        }
      `,
    },
    {
      name: "type-only imports and the Prisma namespace are not the client",
      filename: SERVICE,
      code: `
        import type { PrismaClient, Task } from "@project/db";
        import { type PrismaClient as Client, Prisma } from "@prisma/client";

        export function sql(id: string) {
          return Prisma.sql\`SELECT 1 WHERE id = \${id}\`;
        }
      `,
    },
    {
      name: "reads through the untracked client are left alone (README sharing kit)",
      filename: SERVICE,
      code: `
        export const resolveUser = async ({ name, email }) => {
          if (email !== undefined) {
            return (await prisma.user.findUnique({ where: { email }, select: { id: true } }))?.id;
          }
          const named = await prisma.user.findMany({ where: { name }, select: { id: true }, take: 2 });
          return named.length === 1 ? named[0]?.id : null;
        };
      `,
    },
    {
      name: "test fixtures write untracked by design (the kit fixtures' addTasks)",
      filename: SERVICE_TEST,
      code: `
        import { prisma } from "@project/db";
        export async function addTasks(projectId, titles) {
          for (const title of titles) {
            await prisma.task.create({ data: { projectId, title } });
          }
        }
      `,
    },
    {
      name: "a seed script is not a service, job or route",
      filename: "packages/db/src/seed.ts",
      code: `
        import { prisma } from "./index";
        await prisma.user.create({ data: { email: "ada@example.com" } });
      `,
    },
    {
      name: "writers whose parameter is named prisma but typed Tracked write through the tracked client (farseer's harness writers)",
      filename: JOB,
      code: `
        import type { Tracked, TrackedTransaction } from "@fitzzero/quickdraw-core";
        import type { PrismaClient } from "@project/db";

        export async function addTask(prisma: Tracked<PrismaClient>, projectId: string) {
          return await prisma.task.create({ data: { projectId, title: "Write the plan" } });
        }

        export async function closeTasks(prisma: TrackedTransaction<PrismaClient>, ids: string[]) {
          await prisma.task.updateMany({ where: { id: { in: ids } }, data: { status: "done" } });
        }
      `,
    },
    {
      name: "a variable typed with a qualified Tracked",
      filename: SERVICE,
      code: `
        import type * as quickdraw from "@fitzzero/quickdraw-core";
        import { db } from "../db";

        const prisma: quickdraw.Tracked<typeof db> = db;
        export const archive = (id: string) => prisma.task.delete({ where: { id } });
      `,
    },
    {
      name: "a parameter with a default, typed as either tracked type",
      filename: ROUTE,
      code: `
        import { db } from "../db";

        export function rename(id: string, title: string, prisma: Tracked<Db> | TrackedTransaction<Db> = db) {
          return prisma.task.update({ where: { id }, data: { title } });
        }
      `,
    },
    {
      name: "a parameter named db with no type is judged by its name, as before",
      filename: SERVICE,
      code: `
        export function archive(db, id) {
          return db.task.update({ where: { id }, data: { archived: true } });
        }
      `,
    },
  ],
  invalid: [
    {
      name: "importing the untracked client into a service",
      filename: SERVICE,
      code: `import { prisma } from "@project/db";`,
      errors: [
        {
          messageId: "importClient",
          data: { name: "prisma", source: "@project/db" },
        },
      ],
    },
    {
      name: "constructing a client in a job",
      filename: JOB,
      code: `
        import { PrismaClient } from "@prisma/client";
        const client = new PrismaClient();
      `,
      errors: [
        { messageId: "importClient", data: { name: "PrismaClient", source: "@prisma/client" } },
      ],
    },
    {
      name: "the generated client module, by path",
      filename: SERVICE,
      code: `import { PrismaClient } from "../../prisma/generated/prisma/client.js";`,
      errors: [{ messageId: "importClient" }],
    },
    {
      name: "writing through prisma in a route",
      filename: ROUTE,
      code: `
        export async function onPaid(event) {
          await prisma.invoice.update({ where: { id: event.invoiceId }, data: { paid: true } });
        }
      `,
      errors: [
        {
          message:
            "`prisma.invoice.update()` writes through the untracked client, so subscribers never see this change. Write through the handler's `db` argument, or through the tracked client inside `qd.run(() => ...)`. A parameter or variable given the tracked client says so with its type, whatever its name: `Tracked<Db>`.",
        },
      ],
    },
    {
      name: "a client member named prisma, and every write method",
      filename: SERVICE,
      code: `
        this.prisma.chat.create({ data });
        deps.prisma.chat.upsert({ where, create, update });
        prisma.chat.deleteMany({ where });
      `,
      errors: [
        {
          messageId: "untrackedWrite",
          data: { client: "prisma", model: "chat", method: "create" },
        },
        {
          messageId: "untrackedWrite",
          data: { client: "prisma", model: "chat", method: "upsert" },
        },
        {
          messageId: "untrackedWrite",
          data: { client: "prisma", model: "chat", method: "deleteMany" },
        },
      ],
    },
    {
      name: "another layout and another client name, through the options",
      filename: "src/server/handlers/task.ts",
      options: [{ files: ["**/server/**"], clients: ["rawDb"], modules: ["~/db"] }],
      code: `
        import { rawDb } from "~/db";
        rawDb.task.delete({ where: { id } });
      `,
      errors: [{ messageId: "importClient" }, { messageId: "untrackedWrite" }],
    },
    {
      name: "a parameter named prisma with the untracked client's type, or none, is judged by its name",
      filename: JOB,
      code: `
        import type { PrismaClient } from "@project/db";

        export async function addTask(prisma: PrismaClient, projectId: string) {
          await prisma.task.create({ data: { projectId, title: "Write the plan" } });
        }

        export async function removeTask(prisma, id) {
          await prisma.task.delete({ where: { id } });
        }
      `,
      errors: [
        {
          messageId: "untrackedWrite",
          data: { client: "prisma", model: "task", method: "create" },
        },
        {
          messageId: "untrackedWrite",
          data: { client: "prisma", model: "task", method: "delete" },
        },
      ],
    },
    {
      name: "a union that admits the untracked client's type is not tracked",
      filename: SERVICE,
      code: `
        export function rename(prisma: Tracked<Db> | PrismaClient, id: string) {
          return prisma.task.update({ where: { id }, data: { title: "Renamed" } });
        }
      `,
      errors: [{ messageId: "untrackedWrite" }],
    },
    {
      name: "a tracked parameter covers its own binding, not another one of the same name",
      filename: JOB,
      code: `
        import { prisma } from "@project/db";

        function addTask(prisma: Tracked<Db>, projectId: string) {
          return prisma.task.create({ data: { projectId, title: "Write the plan" } });
        }

        export async function sweep(projectId: string) {
          await addTask(prisma, projectId);
          await prisma.task.deleteMany({ where: { projectId, status: "done" } });
        }
      `,
      errors: [
        { messageId: "importClient", data: { name: "prisma", source: "@project/db" } },
        {
          messageId: "untrackedWrite",
          data: { client: "prisma", model: "task", method: "deleteMany" },
        },
      ],
    },
  ],
});
