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
      // The review's bad3 case: per-row data that moves rows between scopes.
      name: "per-row writes through an interactive transaction's client, inside it",
      filename: SERVICE,
      code: `
        const handler = ({ input, db }) =>
          db.$transaction(async (tx) => {
            for (const m of input.moves) {
              await tx.task.update({ where: { id: m.id }, data: { projectId: m.projectId } });
            }
            await Promise.all(input.gone.map(async (id) => await tx.task.delete({ where: { id } })));
            return input.moves.length;
          });
      `,
    },
    {
      name: "in: filters on the loop's own set: its binding, a variable derived from it, a callback's parameter",
      filename: JOB,
      code: `
        for (let start = 0; start < ids.length; start += 500) {
          await db.task.updateMany({ where: { id: { in: ids.slice(start, start + 500) } }, data: { late: true } });
        }
        for (const { taskIds } of batches) {
          await db.task.deleteMany({ where: { id: { in: taskIds } } });
        }
        for (const chunk of chunks(rows, 500)) {
          const chunkIds = chunk.map((row) => row.id);
          await db.task.updateMany({ where: { id: { in: chunkIds } }, data: { seen: true } });
        }
        await Promise.all(chunks(ids, 500).map((chunk) => db.task.findMany({ where: { id: { in: chunk } } })));
      `,
    },
    {
      name: "a map whose promises go to a batch transaction, or are not sent together",
      filename: SERVICE,
      code: `
        await db.$transaction(ids.map((id) => db.task.update({ where: { id }, data: { seen: true } })));
        const pending = ids.map((id) => db.task.findUnique({ where: { id } }));
        await Promise.race(ids.map((id) => db.task.findUnique({ where: { id } })));
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
            "`await db.task.update()` inside a for...of loop runs one query per item. Read the items in one call (`findMany({ where: { id: { in: ids } } })`), write them in one when every row gets the same data (`updateMany`, `createMany`), or write each row by id inside an interactive transaction (`db.$transaction(async (tx) => { for (...) await tx.task.update(...) })`).",
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
      name: "reads inside an interactive transaction, and a tx that is not a transaction's",
      filename: SERVICE,
      code: `
        await db.$transaction(async (tx) => {
          for (const id of ids) {
            await tx.task.findUnique({ where: { id } });
          }
        });
        await withRetry(async (tx) => {
          for (const id of ids) {
            await tx.task.update({ where: { id }, data: { seen: true } });
          }
        });
      `,
      errors: [
        {
          messageId: "callInLoop",
          data: { client: "tx", model: "task", method: "findUnique", loop: "a for...of loop" },
        },
        {
          messageId: "callInLoop",
          data: { client: "tx", model: "task", method: "update", loop: "a for...of loop" },
        },
      ],
    },
    {
      // The review's loops.ts m1 and m2.
      name: "a map's model calls sent to Promise.all: one query per item, all at once",
      filename: SERVICE,
      code: `
        const m1 = async ({ input, db }) => Promise.all(input.ids.map((id) => db.task.findUnique({ where: { id } })));
        const m2 = async ({ input, db }) => {
          const rows = await Promise.all(input.ids.map((id) => db.task.findUnique({ where: { id } })));
          return rows;
        };
        await Promise.allSettled(input.ids.flatMap((id) => { return db.task.delete({ where: { id } }); }));
      `,
      errors: [
        {
          message:
            "`db.task.findUnique()` returned from a .map() callback whose results go to `Promise.all` runs one query per item, all at once. Read the items in one call (`findMany({ where: { id: { in: ids } } })`), write them in one when every row gets the same data (`updateMany`, `createMany`), or write each row by id inside an interactive transaction (`db.$transaction(async (tx) => { for (...) await tx.task.update(...) })`).",
        },
        {
          messageId: "callPerItem",
          data: { client: "db", model: "task", method: "findUnique", loop: "a .map() callback" },
        },
        {
          messageId: "callPerItem",
          data: { client: "db", model: "task", method: "delete", loop: "a .flatMap() callback" },
        },
      ],
    },
    {
      // The review's loops.ts m4.
      name: "an in: filter on something other than the loop's set does not make it one query",
      filename: SERVICE,
      code: `
        for (const project of input.projects) {
          out.push(await db.task.findMany({ where: { projectId: project, status: { in: ["open", "done"] } }, take: 10 }));
        }
      `,
      errors: [
        {
          messageId: "callInLoop",
          data: { client: "db", model: "task", method: "findMany", loop: "a for...of loop" },
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
