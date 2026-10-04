import { JOB, SERVICE, SERVICE_TEST, run } from "./tester.mjs";

run("no-raw-sql-write", {
  valid: [
    {
      name: "a raw write that touches the rows it changed",
      filename: SERVICE,
      code: `
        const methods = {
          shift: {
            access: { scope: "Moderate", of: project, id: "projectId" },
            handler: async ({ input, ctx, db }) => {
              await db.$executeRaw\`UPDATE "Task" SET "ordinal" = "ordinal" + 1 WHERE "id" = ANY(\${input.ids})\`;
              ctx.touch("task", input.ids);
              return null;
            },
          },
        };
      `,
    },
    {
      name: "a raw read (the README's full-text search strategy)",
      filename: SERVICE,
      code: `
        const strategy = {
          where: async (q, ctx) => {
            const rows = await prisma.$queryRaw\`
              SELECT t.id FROM "Task" t
              JOIN "ProjectMember" m ON m."projectId" = t."projectId"
              WHERE m."userId" = \${ctx.principal.userId}
                AND t."searchVector" @@ websearch_to_tsquery('english', \${q})
              LIMIT 1000\`;
            return { id: { in: rows.map((row) => row.id) } };
          },
        };
      `,
    },
    {
      name: "a destructured touch, and a job resetting the collection it changed",
      filename: JOB,
      code: `
        export const purge = async ({ input, ctx: { touch }, db }) => {
          await db.$executeRawUnsafe('DELETE FROM "Task" WHERE "id" = $1', input.id);
          touch("task", [input.id], { removed: true });
        };
        export async function renumber(projectId) {
          await qd.run(() => db.$executeRaw\`UPDATE "Task" SET "ordinal" = "ordinal" * 2 WHERE "projectId" = \${projectId}\`);
          qd.collections.reset(task, "byProject", projectId);
        }
      `,
    },
    {
      name: "a job touching the rows through the context qd.run gives it",
      filename: JOB,
      code: `
        export async function markLate(ids) {
          await qd.run(async (ctx) => {
            await db.$executeRaw\`UPDATE "Task" SET "status" = 'late' WHERE "id" = ANY(\${ids})\`;
            ctx.touch("task", ids);
          });
          await qd.run(async ({ touch }) => {
            await db.$executeRawUnsafe('DELETE FROM "Task" WHERE "id" = ANY($1)', ids);
            touch("task", ids, { removed: true });
          });
        }
      `,
    },
    {
      name: "tests and scripts outside services, jobs and routes",
      filename: SERVICE_TEST,
      code: `await prisma.$executeRawUnsafe('TRUNCATE "Task" CASCADE');`,
    },
  ],
  invalid: [
    {
      name: "a raw write in a handler that records nothing",
      filename: SERVICE,
      code: `
        const methods = {
          archiveAll: {
            access: { service: "Admin" },
            handler: async ({ db }) => {
              await db.$executeRaw\`UPDATE "Task" SET "archived" = true\`;
              return null;
            },
          },
        };
      `,
      errors: [
        {
          message:
            "`$executeRaw` writes rows the tracked client cannot see, so their subscribers hear nothing. Record them with `ctx.touch(model, ids)` in the same function (`{ removed: true }` for deleted rows; `qd.collections.reset(...)` from a job), or write through `db.<model>`.",
        },
      ],
    },
    {
      name: "$queryRaw running a write, and Prisma.sql",
      filename: JOB,
      code: `
        export async function close() {
          const rows = await db.$queryRaw\`
            -- close every overdue task
            UPDATE "Task" SET "status" = 'late' WHERE "dueAt" < now() RETURNING id\`;
          await db.$executeRaw(Prisma.sql\`DELETE FROM "Session" WHERE "expiresAt" < now()\`);
          await db.$queryRawUnsafe("insert into audit (at) values (now())");
          return rows;
        }
      `,
      errors: [
        { messageId: "rawWrite", data: { method: "$queryRaw" } },
        { messageId: "rawWrite", data: { method: "$executeRaw" } },
        { messageId: "rawWrite", data: { method: "$queryRawUnsafe" } },
      ],
    },
    {
      name: "a touch in another handler does not count",
      filename: SERVICE,
      code: `
        const methods = {
          a: { access: "authenticated", handler: ({ ctx }) => ctx.touch("task", []) },
          b: {
            access: "authenticated",
            handler: async ({ db }) => {
              await db.$executeRawUnsafe('DELETE FROM "Task"');
            },
          },
        };
      `,
      errors: [{ messageId: "rawWrite", data: { method: "$executeRawUnsafe" } }],
    },
  ],
});
