import { SERVICE, run } from "./tester.mjs";

run("no-inline-auth-guard", {
  valid: [
    {
      name: "access forms, and a handler throwing for its own reasons (the e2e fixture app's rename)",
      filename: SERVICE,
      code: `
        const methods = {
          rename: {
            access: { entry: "Moderate" },
            handler: async ({ input, db }) => {
              await gate.wait();
              if (input.title === "conflict") {
                throw new QuickdrawError("CONFLICT", "That title is taken");
              }
              return await db.task.update({ where: { id: input.id }, data: { title: input.title } });
            },
          },
          mine: {
            access: "authenticated",
            handler: ({ ctx, db }) => db.task.findMany({ where: { assigneeId: ctx.principal.userId }, take: 50 }),
          },
        };
      `,
    },
    {
      name: "a public method answering anonymous callers differently returns instead of throwing",
      filename: SERVICE,
      code: `
        const methods = {
          feed: {
            access: "public",
            handler: async ({ ctx, db }) => {
              if (!ctx.principal) return [];
              return db.post.findMany({ where: { authorId: ctx.principal.userId }, take: 20 });
            },
          },
        };
      `,
    },
    {
      name: "checks of what the principal may do, and guards outside handlers",
      filename: SERVICE,
      code: `
        const methods = {
          publish: {
            access: "authenticated",
            handler: ({ input, ctx }) => {
              if (!ctx.principal.claims.editor) throw new QuickdrawError("FORBIDDEN", "Editors only");
              if (!ctx.principal && input.strict) throw new Error("strict");
              return publish(input);
            },
          },
        };
        export function requireUser(ctx) {
          if (!ctx.principal) throw new Error("Sign in first");
          return ctx.principal;
        }
      `,
    },
  ],
  invalid: [
    {
      name: "the plain guard",
      filename: SERVICE,
      code: `
        const methods = {
          rename: {
            access: "public",
            handler: async ({ input, ctx, db }) => {
              if (!ctx.principal) throw new QuickdrawError("UNAUTHENTICATED", "Sign in");
              return db.task.update({ where: { id: input.id }, data: { title: input.title } });
            },
          },
        };
      `,
      errors: [
        {
          message:
            "Don't check `ctx.principal` by hand: declare it in the method's `access` (`\"authenticated\"`, `{ service }`, `{ entry }`, `{ scope, of, id }` or `custom(fn)`). The dispatcher then refuses anonymous callers with `UNAUTHENTICATED` before the handler runs, on every transport, and `ctx.principal` is typed as present.",
        },
      ],
    },
    {
      name: "optional chains, null comparisons and blocks",
      filename: SERVICE,
      code: `
        const methods = {
          a: { access: "public", handler: ({ ctx }) => { if (!ctx.principal?.userId) { throw new Error("no"); } } },
          b: { access: "public", handler: ({ ctx }) => { if (ctx.principal === null) throw new Error("no"); } },
          c: { access: "public", handler({ ctx }) { if (undefined == ctx.principal) throw new Error("no"); } },
        };
      `,
      errors: [
        { messageId: "inlineGuard" },
        { messageId: "inlineGuard" },
        { messageId: "inlineGuard" },
      ],
    },
    {
      name: "a destructured principal, and one side of ||",
      filename: SERVICE,
      code: `
        const methods = {
          a: {
            access: "public",
            handler: async ({ input, ctx: { principal } }) => {
              if (!principal) throw new Error("Sign in");
              return input;
            },
          },
          b: {
            access: "public",
            handler: async ({ input, ctx }) => {
              if (!ctx.principal || input.ownerId !== ctx.principal.userId) {
                throw new QuickdrawError("FORBIDDEN", "Not yours");
              }
            },
          },
        };
      `,
      errors: [{ messageId: "inlineGuard" }, { messageId: "inlineGuard" }],
    },
  ],
});
