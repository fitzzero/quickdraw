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
        export const resolveUser = async ({ name, email }) =>
          (await prisma.user.findFirst({ where: name === undefined ? { email } : { name } }))?.id;
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
            "`prisma.invoice.update()` writes through the untracked client, so subscribers never see this change. Write through the handler's `db` argument, or through the tracked client inside `qd.run(() => ...)`.",
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
  ],
});
