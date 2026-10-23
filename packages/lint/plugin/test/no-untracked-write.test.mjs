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
        import type { Tracked, TrackedTransaction } from "@fitzzero/quickdraw-core/prisma";
        import { db } from "../db";

        export function rename(id: string, title: string, prisma: Tracked<Db> | TrackedTransaction<Db> = db) {
          return prisma.task.update({ where: { id }, data: { title } });
        }
      `,
    },
    {
      name: "quickdraw's types under an alias, from either module, and through this file's alias of one",
      filename: JOB,
      code: `
        import type { Tracked as TrackedClient } from "@fitzzero/quickdraw-core/prisma";
        import type { TrackedTransaction as InTransaction } from "@fitzzero/quickdraw-core";
        import type { PrismaClient } from "@project/db";

        type TrackedDb = TrackedClient<PrismaClient>;

        export async function addTask(prisma: TrackedClient<PrismaClient>, projectId: string) {
          return await prisma.task.create({ data: { projectId, title: "Write the plan" } });
        }

        export async function closeTasks(prisma: InTransaction<PrismaClient>, ids: string[]) {
          await prisma.task.updateMany({ where: { id: { in: ids } }, data: { status: "done" } });
        }

        export async function dropTask(prisma: TrackedDb, id: string) {
          await prisma.task.delete({ where: { id } });
        }
      `,
    },
    {
      name: "a destructured parameter whose pattern's type gives it a tracked type, nested and with a default",
      filename: JOB,
      code: `
        import type { Tracked, TrackedTransaction } from "@fitzzero/quickdraw-core/prisma";
        import type { PrismaClient } from "@project/db";
        import { db } from "../db";

        export async function addTask({ prisma, projectId }: { prisma: Tracked<PrismaClient>; projectId: string }) {
          return await prisma.task.create({ data: { projectId, title: "Write the plan" } });
        }

        export async function sweep({
          deps: { prisma = db },
        }: {
          deps: { prisma: TrackedTransaction<PrismaClient> };
        }) {
          await prisma.task.deleteMany({ where: { status: "done" } });
        }
      `,
    },
    {
      name: "a destructured parameter typed with this file's interface or type alias",
      filename: SERVICE,
      code: `
        import type { Tracked, TrackedTransaction } from "@fitzzero/quickdraw-core/prisma";
        import type { PrismaClient } from "@project/db";

        interface WriterDeps {
          prisma: Tracked<PrismaClient>;
        }
        export type InTransaction = { prisma: TrackedTransaction<PrismaClient> } & { projectId: string };

        export const addLabel = async ({ prisma }: WriterDeps, name: string) =>
          prisma.label.create({ data: { name } });

        export const closeTasks = async ({ prisma, projectId }: InTransaction) =>
          prisma.task.updateMany({ where: { projectId }, data: { status: "done" } });
      `,
    },
    {
      name: "a class member declared with a tracked type: a property, a private one, or a constructor's parameter property",
      filename: JOB,
      code: `
        import type { Tracked } from "@fitzzero/quickdraw-core/prisma";
        import type { PrismaClient } from "@project/db";

        export class TaskWriter {
          private readonly prisma: Tracked<PrismaClient>;
          #audit: Tracked<PrismaClient>;

          constructor(prisma: Tracked<PrismaClient>) {
            this.prisma = prisma;
            this.#audit = prisma;
          }

          async add(projectId: string) {
            await this.prisma.task.create({ data: { projectId, title: "Write the plan" } });
            await this.#audit.auditLog.create({ data: { projectId } });
          }

          archive = async (id: string) => {
            await this.prisma.task.update({ where: { id }, data: { archived: true } });
          };
        }

        export class LabelWriter {
          constructor(private readonly prisma: Tracked<PrismaClient>) {}

          async add(name: string) {
            await this.prisma.label.create({ data: { name } });
          }
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
            "`prisma.invoice.update()` writes through the untracked client, so subscribers never see this change. Write through the handler's `db` argument, or through the tracked client inside `qd.run(() => ...)`. A parameter, variable or class member given the tracked client says so with its type, whatever its name: `Tracked<Db>`, imported from `@fitzzero/quickdraw-core/prisma`.",
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
      name: "a Tracked of the app's own, or imported from another module, is not quickdraw's",
      filename: JOB,
      code: `
        import type { Tracked as Mine } from "../tracked";
        import type * as helpers from "./helpers";

        type Tracked<C> = C;

        export function rename(prisma: Tracked<Db>, id: string) {
          return prisma.task.update({ where: { id }, data: { title: "Renamed" } });
        }

        export function archive(prisma: Mine<Db>, id: string) {
          return prisma.task.update({ where: { id }, data: { archived: true } });
        }

        export function drop(prisma: helpers.Tracked<Db>, id: string) {
          return prisma.task.delete({ where: { id } });
        }
      `,
      errors: [
        {
          messageId: "untrackedWrite",
          data: { client: "prisma", model: "task", method: "update" },
        },
        {
          messageId: "untrackedWrite",
          data: { client: "prisma", model: "task", method: "update" },
        },
        {
          messageId: "untrackedWrite",
          data: { client: "prisma", model: "task", method: "delete" },
        },
      ],
    },
    {
      name: "a destructured binding its pattern's type does not type tracked, or types with a type of another file",
      filename: JOB,
      code: `
        import type { Tracked } from "@fitzzero/quickdraw-core/prisma";
        import type { WriterDeps } from "./deps";

        export async function addTask({ prisma }: { db: Tracked<Db>; prisma: PrismaClient }) {
          await prisma.task.create({ data: { title: "Write the plan" } });
        }

        export async function addLabel({ prisma }: WriterDeps) {
          await prisma.label.create({ data: { name: "bug" } });
        }
      `,
      errors: [
        {
          messageId: "untrackedWrite",
          data: { client: "prisma", model: "task", method: "create" },
        },
        {
          messageId: "untrackedWrite",
          data: { client: "prisma", model: "label", method: "create" },
        },
      ],
    },
    {
      name: "a member with no tracked type in its class, and this in a plain function, are the untracked client",
      filename: JOB,
      code: `
        import type { Tracked } from "@fitzzero/quickdraw-core/prisma";

        export class Typed {
          prisma: Tracked<Db>;
        }

        export class Untyped {
          prisma = makeClient();

          async add() {
            await this.prisma.task.create({ data: { title: "Write the plan" } });
          }
        }

        export class Later {
          private readonly prisma: Tracked<Db>;

          schedule() {
            setTimeout(function () {
              this.prisma.task.deleteMany({ where: { status: "done" } });
            });
          }
        }
      `,
      errors: [
        {
          messageId: "untrackedWrite",
          data: { client: "prisma", model: "task", method: "create" },
        },
        {
          messageId: "untrackedWrite",
          data: { client: "prisma", model: "task", method: "deleteMany" },
        },
      ],
    },
    {
      name: "a union that admits the untracked client's type is not tracked",
      filename: SERVICE,
      code: `
        import type { Tracked } from "@fitzzero/quickdraw-core/prisma";

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
        import type { Tracked } from "@fitzzero/quickdraw-core/prisma";
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
