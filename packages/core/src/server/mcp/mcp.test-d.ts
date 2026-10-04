// Type tests for the MCP bridge (RFC 0003 section 10): `ctx.mcp` typed by the
// app's `QuickdrawTypes["mcp"]`, and the registry's hooks, references and
// custom tools typed by the services they serve. Each `@ts-expect-error` sits
// on the line the compiler reports, so a rule that stops failing breaks
// `bun run typecheck`.

import { describe, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { defineContract, mutation, query } from "../../index";
import { custom, initQuickdraw, type BaseContext, type Principal } from "../index";
import {
  createMcpRegistry,
  describeTools,
  type McpCallResult,
  type McpCustomTool,
  type McpRegistry,
  type McpRequest,
  type McpTool,
  type McpToolAccess,
} from "./index";

interface AppPrincipal extends Principal {
  readonly kind: "user" | "agent";
}

interface Scopes {
  readonly scopes: readonly string[];
}

const qd = initQuickdraw<{ principal: AppPrincipal; mcp: Scopes }>();

const note = defineContract("noteService", {
  methods: {
    find: query({
      input: z.object({ id: z.string() }),
      output: z.string(),
      describe: "Finds a note.",
    }),
    drop: mutation({ input: z.object({ id: z.string() }), output: z.boolean() }),
  },
});

const noteService = qd.defineService(note, {
  methods: {
    find: {
      access: "public",
      handler: ({ ctx }) => {
        expectTypeOf(ctx.mcp).toEqualTypeOf<Scopes | undefined>();
        return ctx.mcp?.scopes.join(",") ?? "";
      },
    },
    drop: {
      access: custom((ctx) => {
        expectTypeOf(ctx.mcp).toEqualTypeOf<Scopes | undefined>();
        return ctx.mcp?.scopes.includes("notes:write") ?? true;
      }),
      handler: () => true,
    },
  },
});

const dispatcher = qd.createDispatcher({ services: [noteService] });

describe("ctx.mcp", () => {
  test("is typed by the app's QuickdrawTypes['mcp'] in handlers, access checks and context", () => {
    initQuickdraw<{ mcp: Scopes; context: { readonly writer: boolean } }>({
      context: (base) => {
        expectTypeOf(base.mcp).toEqualTypeOf<Scopes | undefined>();
        return { writer: base.mcp?.scopes.includes("write") ?? false };
      },
    });
  });

  test("holds fields of any value when the app declares no mcp type", () => {
    initQuickdraw().defineService(note, {
      methods: {
        find: {
          access: "public",
          handler: ({ ctx }) => {
            expectTypeOf(ctx.mcp).toEqualTypeOf<Readonly<Record<string, unknown>> | undefined>();
            return "";
          },
        },
        drop: { access: "public", handler: () => false },
      },
    });
    expectTypeOf<BaseContext["mcp"]>().toEqualTypeOf<
      Readonly<Record<string, unknown>> | undefined
    >();
  });
});

describe("createMcpRegistry", () => {
  test("returns a registry whose calls resolve with a result", () => {
    const registry = createMcpRegistry({ services: [noteService], dispatcher });
    expectTypeOf(registry).toEqualTypeOf<McpRegistry>();
    expectTypeOf(registry.tools).toEqualTypeOf<readonly McpTool[]>();
    expectTypeOf(registry.call).returns.resolves.toEqualTypeOf<McpCallResult>();
    expectTypeOf(describeTools([noteService])).toEqualTypeOf<McpTool[]>();
  });

  test("principal returns the app's principal, and context the app's ctx.mcp fields", () => {
    createMcpRegistry({
      services: [noteService],
      dispatcher,
      // The return type is written out: TypeScript widens `kind: "agent"` to
      // a string while it infers the services, as with createServer's
      // `authenticate`.
      principal: (request): AppPrincipal | null => {
        expectTypeOf(request).toEqualTypeOf<McpRequest>();
        return request.transport === "http" && request.token !== null
          ? { userId: request.token, kind: "agent" }
          : null;
      },
      context: (_request, principal) => {
        expectTypeOf(principal).toEqualTypeOf<AppPrincipal | null>();
        return { scopes: [] };
      },
    });
    createMcpRegistry({
      services: [noteService],
      dispatcher,
      // @ts-expect-error -- the app's principal needs a kind, so a bare user id is not one
      principal: () => "alice",
    });
    createMcpRegistry({
      services: [noteService],
      dispatcher,
      // @ts-expect-error -- ctx.mcp is typed as { scopes }
      context: () => ({ tenant: "acme" }),
    });
  });

  test("include and exclude name the services served and their methods", () => {
    createMcpRegistry({
      services: [noteService],
      dispatcher,
      include: ["noteService"],
      exclude: ["noteService.drop"],
    });
    createMcpRegistry({
      services: [noteService],
      dispatcher,
      // @ts-expect-error -- noteService has no method "remove"
      exclude: ["noteService.remove"],
    });
    describeTools([noteService], {
      // @ts-expect-error -- taskService is not served
      include: ["taskService"],
    });
  });

  test("a custom tool's handler gets the typed principal, ctx.mcp fields and caller", () => {
    createMcpRegistry({
      services: [noteService],
      dispatcher,
      customTools: [
        {
          name: "recent",
          description: "Lists recent notes.",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
          handler: async ({ arguments: args, principal, mcp, caller, signal }) => {
            expectTypeOf(args).toBeUnknown();
            expectTypeOf(principal).toEqualTypeOf<AppPrincipal | null>();
            expectTypeOf(mcp).toEqualTypeOf<Scopes | undefined>();
            expectTypeOf(signal).toEqualTypeOf<AbortSignal>();
            expectTypeOf(caller.noteService.find).parameter(0).toEqualTypeOf<{ id: string }>();
            return await caller.noteService.find({ id: "n1" });
          },
        },
      ],
    });
  });

  test("a custom tool's arguments are its Standard Schema's output, each tool its own", () => {
    createMcpRegistry({
      services: [noteService],
      dispatcher,
      customTools: [
        {
          name: "search",
          description: "Searches notes.",
          inputSchema: z.object({ q: z.string(), limit: z.number().default(10) }),
          handler: ({ arguments: args }) => {
            expectTypeOf(args).toEqualTypeOf<{ q: string; limit: number }>();
            return args.q.slice(0, args.limit);
          },
        },
        {
          name: "tag",
          description: "Tags a note.",
          inputSchema: z.object({ id: z.string(), tags: z.array(z.string()) }),
          handler: ({ arguments: args }) => {
            expectTypeOf(args).toEqualTypeOf<{ id: string; tags: string[] }>();
            // @ts-expect-error -- the tag tool's arguments have no q
            return args.q;
          },
        },
        {
          name: "raw",
          description: "Takes a JSON Schema object.",
          inputSchema: { type: "object", properties: { id: { type: "string" } } },
          handler: ({ arguments: args }) => {
            expectTypeOf(args).toBeUnknown();
            return null;
          },
        },
      ],
    });
  });

  test("a custom tool's access is public or authenticated, and may be left out", () => {
    expectTypeOf<NonNullable<McpCustomTool["access"]>>().toEqualTypeOf<McpToolAccess>();
    expectTypeOf<McpToolAccess>().toEqualTypeOf<"public" | "authenticated">();
    const tool = { description: "A tool.", inputSchema: { type: "object" as const } };
    createMcpRegistry({
      services: [noteService],
      dispatcher,
      customTools: [
        { ...tool, name: "open", access: "public", handler: () => null },
        { ...tool, name: "closed", access: "authenticated", handler: () => null },
        { ...tool, name: "default", handler: () => null },
      ],
    });
    createMcpRegistry({
      services: [noteService],
      dispatcher,
      customTools: [
        {
          ...tool,
          name: "admin",
          // @ts-expect-error -- a custom tool has no service or row to check a level against
          access: { service: "Admin" },
          handler: () => null,
        },
      ],
    });
  });
});
