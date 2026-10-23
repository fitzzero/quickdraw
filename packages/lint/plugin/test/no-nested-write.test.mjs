import { SERVICE, run } from "./tester.mjs";

run("no-nested-write", {
  valid: [
    {
      name: "a client typed with an app's own Tracked is not the tracked client (no-untracked-write's to judge)",
      filename: SERVICE,
      code: `
        type Tracked<C> = C;

        export async function addLabelled(prisma: Tracked<PrismaClient>, projectId: string) {
          await prisma.task.create({ data: { projectId, labels: { create: [{ name: "bug" }] } } });
        }
      `,
    },
    {
      name: "plain writes (the e2e fixture app's handlers)",
      filename: SERVICE,
      code: `
        const create = ({ input, db }) => db.task.create({ data: input });
        const reorder = ({ input, db }) =>
          db.task.update({ where: { id: input.id }, data: { ordinal: input.ordinal } });
        const assign = ({ input, db }) =>
          db.task.update({ where: { id: input.id }, data: { assigneeId: input.assigneeId } });
      `,
    },
    {
      name: "set on a scalar or a scalar list, and atomic operations, write the row's own columns",
      filename: SERVICE,
      code: `
        db.task.update({
          where: { id },
          data: { title: { set: "x" }, tags: { set: ["a", "b"] }, views: { increment: 1 } },
        });
      `,
    },
    {
      name: "a JSON column and a relation filter in where are not writes",
      filename: SERVICE,
      code: `
        db.task.update({ where: { id, project: { is: { ownerId } } }, data: { details: { color: "red" } } });
        db.task.findMany({ where: { labels: { some: { name } } }, take: 10 });
      `,
    },
    {
      // The review's bad4 case: a JSON column whose keys are named like relation operations.
      name: "a JSON value whose operation-named keys hold literals is not a nested write",
      filename: SERVICE,
      code: `
        db.task.update({ where: { id: input.id }, data: { details: { create: true, update: true, delete: false } } });
        db.task.create({ data: { projectId, details: { connect: "x", upsert: 1, deleteMany: null, disconnect: false } } });
        db.task.update({ where: { id }, data: { details: { update: \`v\${n}\`, createMany: -1, set: "s" } } });
      `,
    },
    {
      name: "the untracked client is not this rule's concern (a seed script)",
      filename: "packages/db/src/seed.ts",
      code: `prisma.task.create({ data: { title, labels: { create: [{ name: "bug" }] } } });`,
    },
  ],
  invalid: [
    {
      name: "a class member typed Tracked, a private one, and a destructured binding are the tracked client too",
      filename: SERVICE,
      code: `
        import type { Tracked } from "@fitzzero/quickdraw-core";

        export class Labeller {
          #db: Tracked<PrismaClient>;
          constructor(private readonly prisma: Tracked<PrismaClient>) {
            this.#db = prisma;
          }
          async add(projectId: string) {
            await this.prisma.task.create({ data: { projectId, labels: { create: [{ name: "bug" }] } } });
            await this.#db.task.create({ data: { projectId, labels: { connect: [{ id: "l1" }] } } });
          }
        }

        export async function addLabelled({ client }: { client: Tracked<PrismaClient> }) {
          await client.task.create({ data: { title, labels: { create: [{ name: "bug" }] } } });
        }
      `,
      errors: [
        { messageId: "nestedWrite", data: { field: "labels", operation: "create", model: "task" } },
        {
          messageId: "nestedWrite",
          data: { field: "labels", operation: "connect", model: "task" },
        },
        { messageId: "nestedWrite", data: { field: "labels", operation: "create", model: "task" } },
      ],
    },
    {
      name: "a nested create",
      filename: SERVICE,
      code: `db.task.create({ data: { projectId, title, labels: { create: [{ name: "bug" }] } } });`,
      errors: [
        {
          message:
            "`labels: { create }` is a nested write: only the `task` row is tracked, so subscribers of the related rows hear nothing. Write the related rows through their own model (in the same `db.$transaction`), set a foreign key column directly, or record them with `ctx.touch(model, ids)`.",
        },
      ],
    },
    {
      name: "connecting a relation",
      filename: SERVICE,
      code: `db.task.update({ where: { id }, data: { project: { connect: { id: projectId } } } });`,
      errors: [
        {
          messageId: "nestedWrite",
          data: { field: "project", operation: "connect", model: "task" },
        },
      ],
    },
    {
      name: "both halves of an upsert",
      filename: SERVICE,
      code: `
        db.project.upsert({
          where: { id },
          create: { name, members: { create: { userId } } },
          update: { members: { deleteMany: {} } },
        });
      `,
      errors: [
        {
          messageId: "nestedWrite",
          data: { field: "members", operation: "create", model: "project" },
        },
        {
          messageId: "nestedWrite",
          data: { field: "members", operation: "deleteMany", model: "project" },
        },
      ],
    },
    {
      name: "delete and disconnect given true (a to-one relation) or a filter",
      filename: SERVICE,
      code: `
        db.task.update({ where: { id }, data: { assignee: { disconnect: true } } });
        db.project.update({ where: { id }, data: { members: { delete: [{ id: memberId }] } } });
      `,
      errors: [
        {
          messageId: "nestedWrite",
          data: { field: "assignee", operation: "disconnect", model: "task" },
        },
        {
          messageId: "nestedWrite",
          data: { field: "members", operation: "delete", model: "project" },
        },
      ],
    },
    {
      name: "an operation given a value built elsewhere may be rows",
      filename: SERVICE,
      code: `db.task.create({ data: { projectId, labels: { create: input.labels } } });`,
      errors: [
        { messageId: "nestedWrite", data: { field: "labels", operation: "create", model: "task" } },
      ],
    },
    {
      name: "a parameter typed Tracked is the tracked client, whatever its name",
      filename: SERVICE,
      code: `
        import type { Tracked } from "@fitzzero/quickdraw-core/prisma";

        export async function addLabelled(prisma: Tracked<PrismaClient>, projectId: string) {
          await prisma.task.create({ data: { projectId, title, labels: { create: [{ name: "bug" }] } } });
        }
      `,
      errors: [
        { messageId: "nestedWrite", data: { field: "labels", operation: "create", model: "task" } },
      ],
    },
    {
      name: "set given rows is a relation set, and tx is the tracked client too",
      filename: SERVICE,
      code: `
        await db.$transaction(async (tx) => {
          await tx.task.update({ where: { id }, data: { labels: { set: [{ id: labelId }] } } });
        });
      `,
      errors: [
        { messageId: "nestedWrite", data: { field: "labels", operation: "set", model: "task" } },
      ],
    },
  ],
});
