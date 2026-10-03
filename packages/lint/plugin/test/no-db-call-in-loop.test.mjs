import { JOB, SERVICE, SERVICE_TEST, run } from "./tester.mjs";

run("no-db-call-in-loop", {
  valid: [
    {
      name: "batched and paged loops: for (;;), while, chunks filtered with in, createMany",
      filename: JOB,
      code: `
        export async function sweep() {
          let cursor;
          for (;;) {
            const batch = await db.task.findMany({ take: 500, cursor, orderBy: { id: "asc" } });
            if (batch.length === 0) break;
            cursor = { id: batch.at(-1).id };
          }
          while (await db.job.count({ where: { done: false } }) > 0) {
            await db.job.updateMany({ where: { done: false }, data: { done: true } });
          }
          for (const chunk of chunks(ids, 500)) {
            await db.task.updateMany({ where: { id: { in: chunk } }, data: { late: true } });
            await db.audit.createMany({ data: chunk.map((id) => ({ taskId: id })) });
          }
        }
      `,
    },
    {
      name: "per-row promises sent together, and a read outside the loop",
      filename: SERVICE,
      code: `
        const handler = async ({ input, db }) => {
          const tasks = await db.task.findMany({ where: { id: { in: input.ids } } });
          await db.$transaction(input.moves.map((move) => db.task.update({ where: { id: move.id }, data: { ordinal: move.ordinal } })));
          return tasks;
        };
      `,
    },
    {
      name: "a function made in a loop does not run there",
      filename: SERVICE,
      code: `
        for (const id of ids) {
          handlers.push(async () => {
            await db.task.update({ where: { id }, data: { seen: true } });
          });
        }
      `,
    },
    {
      name: "test fixtures seed rows one by one (the kit fixtures' addTasks)",
      filename: SERVICE_TEST,
      code: `
        export async function addTasks(prisma, projectId, ordinals) {
          const ids = [];
          for (const ordinal of ordinals) {
            const task = await prisma.task.create({ data: { projectId, title: \`Task \${ordinal}\`, ordinal } });
            ids.push(task.id);
          }
          return ids;
        }
      `,
    },
  ],
  invalid: [
    {
      name: "one update per item of a for...of loop",
      filename: SERVICE,
      code: `
        const handler = async ({ input, db }) => {
          for (const id of input.ids) {
            await db.task.update({ where: { id }, data: { status: input.status } });
          }
          return null;
        };
      `,
      errors: [
        {
          message:
            "`await db.task.update()` inside a for...of loop runs one query per item. Read or write the items in one call (`findMany({ where: { id: { in: ids } } })`, `updateMany`, `createMany`), or send per-row writes together with `db.$transaction([...])`.",
        },
      ],
    },
    {
      name: "for and for...in loops",
      filename: JOB,
      code: `
        for (let index = 0; index < ids.length; index += 1) {
          const row = await db.task.findUnique({ where: { id: ids[index] } });
        }
        for (const userId in grants) {
          await tx.user.update({ where: { id: userId }, data: { serviceAccess: grants[userId] } });
        }
      `,
      errors: [
        {
          messageId: "callInLoop",
          data: { client: "db", model: "task", method: "findUnique", loop: "a for loop" },
        },
        {
          messageId: "callInLoop",
          data: { client: "tx", model: "user", method: "update", loop: "a for...in loop" },
        },
      ],
    },
    {
      name: "forEach and map callbacks (N+1 reads)",
      filename: SERVICE,
      code: `
        items.forEach(async (item) => {
          await db.task.create({ data: item });
        });
        const withTasks = await Promise.all(
          projects.map(async (project) => ({
            ...project,
            tasks: await prisma.task.findMany({ where: { projectId: project.id } }),
          })),
        );
      `,
      errors: [
        {
          messageId: "callInLoop",
          data: { client: "db", model: "task", method: "create", loop: "a .forEach() callback" },
        },
        {
          messageId: "callInLoop",
          data: { client: "prisma", model: "task", method: "findMany", loop: "a .map() callback" },
        },
      ],
    },
  ],
});
