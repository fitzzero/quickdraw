import { ROUTE, SERVICE, run } from "./tester.mjs";

run("no-prisma-in-routes", {
  valid: [
    {
      name: "a route calling a service in process",
      filename: ROUTE,
      code: `
        router.post("/tasks/:id/close", async (req, res) => {
          const task = await qd.caller(req.principal).taskService.close({ id: req.params.id });
          res.json(task);
        });
      `,
    },
    {
      name: "a webhook writing through the tracked client inside qd.run (README)",
      filename: "apps/api/src/routes.ts",
      code: `
        router.post("/hooks/paid", async (req, res) => {
          await qd.run(() => db.invoice.update({ where: { id: req.body.invoiceId }, data: { paid: true } }));
          res.sendStatus(204);
        });
      `,
    },
    {
      name: "database access in a service is not a route's",
      filename: SERVICE,
      code: `const user = await prisma.user.findUnique({ where: { id } });`,
    },
    {
      name: "route tests set up data directly",
      filename: "apps/api/src/routes/__tests__/webhooks.test.ts",
      code: `await prisma.invoice.create({ data: { id: "i1" } });`,
    },
  ],
  invalid: [
    {
      name: "a read in a route handler",
      filename: ROUTE,
      code: `
        router.get("/tasks", async (req, res) => {
          res.json(await prisma.task.findMany({ where: { projectId: req.query.projectId }, take: 50 }));
        });
      `,
      errors: [
        {
          message:
            "`prisma.task.findMany()` in a route handler: routes stay thin. Move the database access into a service method and call it with `qd.caller(principal)` (a webhook's writes may use the tracked client inside `qd.run(() => ...)`).",
        },
      ],
    },
    {
      name: "writes and counts in a routes.ts file",
      filename: "apps/api/src/auth/routes.ts",
      code: `
        await prisma.session.deleteMany({ where: { userId } });
        const n = await this.prisma.session.count({ where: { userId } });
      `,
      errors: [
        {
          messageId: "prismaInRoute",
          data: { client: "prisma", model: "session", method: "deleteMany" },
        },
        {
          messageId: "prismaInRoute",
          data: { client: "prisma", model: "session", method: "count" },
        },
      ],
    },
    {
      name: "another client name, through the options",
      filename: ROUTE,
      options: [{ clients: ["db"] }],
      code: `const tasks = await db.task.findFirst({ where: { id } });`,
      errors: [
        { messageId: "prismaInRoute", data: { client: "db", model: "task", method: "findFirst" } },
      ],
    },
  ],
});
