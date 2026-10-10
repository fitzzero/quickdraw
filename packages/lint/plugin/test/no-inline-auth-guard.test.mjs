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
    {
      name: "a kind tested beside something else, a public method's kind check, and a kind that only answers differently",
      filename: SERVICE,
      code: `
        const methods = {
          setStatus: {
            access: { entry: "Moderate" },
            handler: ({ input, ctx }) => {
              if (ctx.principal.kind === "agent" && input.status === "archived") {
                throw new QuickdrawError("FORBIDDEN", "Agents may not archive");
              }
              if (ctx.principal.kind === "agent") return null;
              return setStatus(input);
            },
          },
          feed: {
            access: "public",
            handler: ({ ctx }) => {
              if (ctx.principal?.kind === "agent") throw new QuickdrawError("FORBIDDEN", "Not for agents");
              return feed();
            },
          },
        };
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
    {
      name: "a guard on the principal's kind",
      filename: SERVICE,
      code: `
        const methods = {
          mint: {
            access: "authenticated",
            handler: ({ input, ctx }) => {
              if (ctx.principal.kind !== "user") throw new QuickdrawError("FORBIDDEN", "Users only");
              return mint(input);
            },
          },
        };
      `,
      errors: [
        {
          message:
            'Don\'t check `ctx.principal.kind` by hand: declare the kinds that may call beside `access`, as `kinds: ["user"]` on the method, on its service, or on `initQuickdraw` for every service. The dispatcher then refuses every other kind with `FORBIDDEN` before the handler runs, on every transport and subscription, whatever its grants.',
        },
      ],
    },
    {
      name: "a kind either way round, in a list, destructured, and one side of ||",
      filename: SERVICE,
      code: `
        const methods = {
          a: { access: { entry: "Read" }, handler: ({ ctx }) => { if ("agent" === ctx.principal.kind) { throw new Error("no"); } } },
          b: { access: "authenticated", handler: ({ ctx: { principal } }) => { if (!USERS.includes(principal.kind)) throw new Error("no"); } },
          c: { access: "authenticated", handler({ input, ctx }) { if (ctx.principal.kind == "runner" || input.locked) throw new Error("no"); } },
        };
      `,
      errors: [{ messageId: "kindGuard" }, { messageId: "kindGuard" }, { messageId: "kindGuard" }],
    },
  ],
});
