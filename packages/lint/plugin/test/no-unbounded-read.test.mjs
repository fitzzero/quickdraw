import { JOB, SERVICE, SERVICE_TEST, run } from "./tester.mjs";

run("no-unbounded-read", {
  valid: [
    {
      name: "a page with take, and a count (the e2e fixture app's countOnBoard)",
      filename: SERVICE,
      code: `
        const methods = {
          countOnBoard: {
            access: { scope: "Read", of: projectContract, id: "projectId" },
            handler: ({ input, db }) => db.task.count({ where: { projectId: input.projectId } }),
          },
          recent: {
            access: "authenticated",
            handler: ({ input, db }) =>
              db.task.findMany({ where: { projectId: input.projectId }, orderBy: { id: "asc" }, take: 50 }),
          },
        };
      `,
    },
    {
      name: "a read by ids is bounded by the ids",
      filename: SERVICE,
      code: `db.task.findMany({ where: { id: { in: input.ids } }, select: { id: true, title: true } });`,
    },
    {
      name: "arguments built elsewhere or spread may carry take",
      filename: SERVICE,
      code: `
        db.task.findMany(args);
        db.task.findMany({ ...page, where: { projectId } });
      `,
    },
    {
      name: "jobs and tests are not services",
      filename: JOB,
      code: `const all = await db.task.findMany({ where: { late: true } });`,
    },
    {
      name: "tests are skipped",
      filename: SERVICE_TEST,
      code: `expect(await db.task.findMany()).toHaveLength(2);`,
    },
  ],
  invalid: [
    {
      name: "no arguments at all",
      filename: SERVICE,
      code: `const tasks = await db.task.findMany();`,
      errors: [
        {
          message:
            "`db.task.findMany()` without `take` reads every matching row, however many there are. Add `take` (with a `cursor` to page), or serve the list as a collection (`useCollection` pages it and keeps it live) or the read/write kit's `list`.",
        },
      ],
    },
    {
      name: "a filter that does not bound the rows",
      filename: SERVICE,
      code: `
        const methods = {
          board: {
            access: { scope: "Read", of: projectContract, id: "projectId" },
            handler: ({ input, db }) => db.task.findMany({ where: { projectId: input.projectId }, orderBy: { ordinal: "asc" } }),
          },
        };
      `,
      errors: [{ messageId: "unbounded", data: { client: "db", model: "task" } }],
    },
    {
      name: "any client name",
      filename: SERVICE,
      code: `
        prisma.user.findMany({ orderBy: { name: "asc" } });
        tx.taskLabel.findMany({ where: { taskId } });
      `,
      errors: [
        { messageId: "unbounded", data: { client: "prisma", model: "user" } },
        { messageId: "unbounded", data: { client: "tx", model: "taskLabel" } },
      ],
    },
  ],
});
