import { SERVICE, run } from "./tester.mjs";

run("no-load-then-filter", {
  valid: [
    {
      name: "the condition is already in where",
      filename: SERVICE,
      code: `
        const handler = ({ input, db }) =>
          db.task.findMany({ where: { projectId: input.projectId, status: "done" }, take: 50 });
      `,
    },
    {
      name: "the loaded rows are used for more than the filter",
      filename: SERVICE,
      code: `
        const handler = async ({ input, db }) => {
          const all = await db.task.findMany({ where: { projectId: input.projectId }, take: 200 });
          const done = all.filter((task) => task.status === "done");
          return { all, done };
        };
      `,
    },
    {
      name: "predicates a where cannot express",
      filename: SERVICE,
      code: `
        const handler = async ({ input, db }) => {
          const page = await db.task.findMany({ where: { projectId: input.projectId }, take: 100 });
          const a = (await db.task.findMany({ take: 100 })).filter((task) => matches(task.title, input.pattern));
          const b = (await db.task.findMany({ take: 100 })).filter((task) => task.labels.length > 0);
          const c = (await db.task.findMany({ take: 100 })).filter((task) => task.startsAt < task.endsAt);
          return [page.filter(isVisible), a, b, c];
        };
      `,
    },
    {
      name: "an array that did not come from the database",
      filename: SERVICE,
      code: `const open = input.tasks.filter((task) => task.status === "open");`,
    },
  ],
  invalid: [
    {
      name: "filtering the awaited read",
      filename: SERVICE,
      code: `
        const handler = async ({ input, db }) =>
          (await db.task.findMany({ where: { projectId: input.projectId }, take: 500 })).filter(
            (task) => task.status === input.status,
          );
      `,
      errors: [
        {
          message:
            "This reads every `task` row `findMany` matches, then keeps some of them with `.filter()` in JavaScript. Move the condition into `findMany({ where })` (or `findFirst` for `.find`) so the database returns only the rows you keep.",
        },
      ],
    },
    {
      name: "the two-statement form",
      filename: SERVICE,
      code: `
        const handler = async ({ input, db }) => {
          const tasks = await db.task.findMany({ where: { projectId: input.projectId }, take: 500 });
          return tasks.filter((task) => !task.archived && task.assigneeId !== null);
        };
      `,
      errors: [{ messageId: "loadThenFilter", data: { model: "task", method: "filter" } }],
    },
    {
      name: "find, string tests, list membership and a block body",
      filename: SERVICE,
      code: `
        const handler = async ({ input, db }) => {
          const first = (await db.task.findMany({ take: 100 })).find((task) => task.title.startsWith(input.prefix));
          const mine = (await prisma.task.findMany({ take: 100 })).filter((task) => input.ids.includes(task.id));
          const late = (await db.task.findMany({ take: 100 })).filter(function (task) {
            return task.ordinal > 10 || task.status === "late";
          });
          return [first, mine, late];
        };
      `,
      errors: [
        { messageId: "loadThenFilter", data: { model: "task", method: "find" } },
        { messageId: "loadThenFilter", data: { model: "task", method: "filter" } },
        { messageId: "loadThenFilter", data: { model: "task", method: "filter" } },
      ],
    },
  ],
});
