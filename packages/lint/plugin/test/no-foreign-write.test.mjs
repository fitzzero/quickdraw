import { SERVICE, run } from "./tester.mjs";

run("no-foreign-write", {
  valid: [
    {
      name: "a service writing its model and the models in writes (the live-data fixtures' project service)",
      filename: SERVICE,
      code: `
        export const projectService = qd.defineService(projectContract, {
          model: "project",
          access: anyOf(jsonAcl("acl", { owner: "ownerId" }), projectMembers),
          writes: ["projectMember", "user"],
          methods: {
            rename: {
              access: { entry: "Moderate" },
              handler: ({ input, db }) =>
                db.project.update({ where: { id: input.id }, data: { name: input.name } }),
            },
            setRole: {
              access: "authenticated",
              handler: async ({ input, db }) =>
                (
                  await db.projectMember.updateMany({
                    where: { projectId: input.projectId, userId: input.userId },
                    data: { role: input.role },
                  })
                ).count,
            },
            setGrants: {
              access: "authenticated",
              handler: async ({ input, db }) => {
                await db.user.update({ where: { id: input.userId }, data: { serviceAccess: input.grants } });
                return null;
              },
            },
          },
        });
      `,
    },
    {
      name: "the read/write kit's service: kit handlers and a prepare hook",
      filename: SERVICE,
      code: `
        export function defineTaskService(options = {}) {
          return qd.defineService(taskContract, {
            model: "task",
            access: inherit({ from: projectContract, via: "projectId" }),
            collections: { board: { anchor: projectContract, bulkThreshold: options.bulkThreshold } },
            methods: {
              ...crud.handlers(taskContract, {
                access: { get: { entry: "Read" }, update: { entry: "Moderate" } },
                prepare: async (input, ctx, db) => ({
                  ...input,
                  assigneeId: ctx.principal.userId,
                  ordinal: await nextOrdinal(db, "task", { projectId: input.projectId }),
                }),
              }),
              archive: {
                access: { entry: "Admin" },
                handler: ({ input, db }) =>
                  db.$transaction(async (tx) => tx.task.update({ where: { id: input.id }, data: { archived: true } })),
              },
            },
          });
        }
      `,
    },
    {
      name: "a write outside any defineService call is not checked",
      filename: SERVICE,
      code: `
        export async function addLabel(db, taskId, labelId) {
          await db.taskLabel.create({ data: { taskId, labelId } });
        }
      `,
    },
    {
      name: "a definition whose model or writes is not written out literally",
      filename: SERVICE,
      code: `
        qd.defineService(a, { ...base, methods: { m: { handler: ({ db }) => db.other.delete({ where }) } } });
        qd.defineService(b, { model: MODEL, methods: { m: { handler: ({ db }) => db.other.delete({ where }) } } });
        qd.defineService(c, { model: "task", writes: WRITES, methods: { m: { handler: ({ db }) => db.other.delete({ where }) } } });
      `,
    },
    {
      name: "reads of other models are fine",
      filename: SERVICE,
      code: `
        qd.defineService(task, {
          model: "task",
          methods: { m: { access: "authenticated", handler: ({ db }) => db.project.findMany({ take: 10 }) } },
        });
      `,
    },
  ],
  invalid: [
    {
      name: "writing a model the service neither owns nor lists",
      filename: SERVICE,
      code: `
        export const taskService = qd.defineService(task, {
          model: "task",
          methods: {
            label: {
              access: { entry: "Moderate" },
              handler: ({ input, db }) => db.taskLabel.create({ data: { taskId: input.id, labelId: input.labelId } }),
            },
          },
        });
      `,
      errors: [
        {
          message:
            '`db.taskLabel.create()` writes `taskLabel`, which is not this service\'s model ("task") and not in its `writes`. Add "taskLabel" to `writes` if this service is meant to change those rows, or ask the service that owns them (`ctx.services`).',
        },
      ],
    },
    {
      name: "a service without a model (the access cache tests' member service)",
      filename: SERVICE,
      code: `
        const memberService = qd.defineService(memberContract, {
          methods: {
            remove: {
              access: "authenticated",
              handler: async ({ input, db }) => {
                await db.projectMember.delete({ where: { projectId_userId: input } });
                return null;
              },
            },
          },
        });
      `,
      errors: [
        {
          messageId: "foreignWrite",
          data: { client: "db", model: "projectMember", method: "delete", own: "it declares none" },
        },
      ],
    },
    {
      name: "a model missing from writes",
      filename: SERVICE,
      code: `
        defineService(task, {
          model: "task",
          writes: ["taskLabel"],
          methods: {
            move: {
              access: { entry: "Admin" },
              handler: async ({ input, db }) => {
                await db.taskLabel.deleteMany({ where: { taskId: input.id } });
                return db.project.update({ where: { id: input.projectId }, data: { touchedAt: new Date() } });
              },
            },
          },
        });
      `,
      errors: [
        {
          messageId: "foreignWrite",
          data: { client: "db", model: "project", method: "update", own: '"task"' },
        },
      ],
    },
    {
      name: "inside an interactive transaction",
      filename: SERVICE,
      code: `
        qd.defineService(task, {
          model: "task",
          methods: {
            assign: {
              access: { entry: "Moderate" },
              handler: ({ input, db }) =>
                db.$transaction(async (tx) => {
                  await tx.user.update({ where: { id: input.userId }, data: { load: { increment: 1 } } });
                  return tx.task.update({ where: { id: input.id }, data: { assigneeId: input.userId } });
                }),
            },
          },
        });
      `,
      errors: [
        {
          messageId: "foreignWrite",
          data: { client: "tx", model: "user", method: "update", own: '"task"' },
        },
      ],
    },
  ],
});
