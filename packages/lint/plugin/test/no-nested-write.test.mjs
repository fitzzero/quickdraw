import { SERVICE, run } from "./tester.mjs";

run("no-nested-write", {
  valid: [
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
