// Shared fixtures for the MCP bridge tests: two sample contracts (a task
// service with an entity and an RPC-only note service), their services,
// agent tokens with scopes, and a registry over a dispatcher. Nothing here
// imports vitest, so the stdio child process loads it too.

import { z } from "zod";
import { defineContract, mutation, query, QuickdrawError } from "../../../index";
import { captureLogger, deferred, type Deferred } from "../../__tests__/fixtures";
import {
  createDispatcher,
  custom,
  initQuickdraw,
  type CallRecord,
  type PipelineOptions,
  type Principal,
} from "../../index";
import { createMcpRegistry, type McpRegistryOptions, type McpRequest } from "../index";

export interface AgentPrincipal extends Principal {
  readonly kind: "user" | "agent";
}

/** What the registry's `context` adds as `ctx.mcp`: the scopes of the agent's token. */
export interface AgentMcp {
  readonly scopes: readonly string[];
}

export const qd = initQuickdraw<{ principal: AgentPrincipal; mcp: AgentMcp }>();

const taskSchema = z.object({ id: z.string(), title: z.string(), done: z.boolean() });

const whoSchema = z.object({
  userId: z.string().nullable(),
  kind: z.string().nullable(),
  transport: z.string(),
  scopes: z.array(z.string()).nullable(),
});

export const task = defineContract("taskService", {
  entity: taskSchema,
  methods: {
    get: query({
      input: z.object({ id: z.string() }),
      output: "entity",
      describe: "Reads one task by its id.",
    }),
    list: query({
      input: z.object({
        done: z.boolean().optional(),
        limit: z.number().int().positive().default(20),
      }),
      output: z.array(taskSchema),
    }),
    rename: mutation({
      input: z.object({ id: z.string(), title: z.string().min(1) }),
      output: "entity",
      describe: "Renames a task. Needs the tasks:write scope.",
    }),
    whoami: query({ input: z.undefined(), output: whoSchema, describe: "Says who is calling." }),
  },
});

export const note = defineContract("noteService", {
  methods: {
    search: query({ input: z.string().min(1), output: z.array(z.string()) }),
    archive: mutation({
      input: z.discriminatedUnion("by", [
        z.object({ by: z.literal("id"), id: z.string() }),
        z.object({ by: z.literal("tag"), tag: z.string() }),
      ]),
      output: z.number(),
    }),
    wait: query({ input: z.object({ key: z.string() }), output: z.string() }),
  },
});

/** The agent tokens the tests use, and what each stands for. */
export const TOKENS: Readonly<
  Record<string, { readonly principal: AgentPrincipal; readonly scopes: readonly string[] }>
> = {
  "reader-token": { principal: { userId: "alice", kind: "agent" }, scopes: ["tasks:read"] },
  "writer-token": {
    principal: { userId: "alice", kind: "agent" },
    scopes: ["tasks:read", "tasks:write"],
  },
};

/**
 * The registry's `principal` and `context` for tokens from `tokenOf`: no
 * token is anonymous, an unknown token fails authentication.
 */
export function agentAuth(tokenOf: (request: McpRequest) => string | null) {
  return {
    principal: (request: McpRequest): AgentPrincipal | null => {
      const token = tokenOf(request);
      if (token === null) {
        return null;
      }
      const entry = TOKENS[token];
      if (entry === undefined) {
        throw new Error(`unknown token ${token}`);
      }
      return entry.principal;
    },
    context: (request: McpRequest): AgentMcp => ({
      scopes: TOKENS[tokenOf(request) ?? ""]?.scopes ?? [],
    }),
  };
}

const row = (id: string, title = "Write the RFC") => ({ id, title, done: false });

/** The two services, with a `wait` query that holds until the test opens its gate. */
export function createServices() {
  const gates = new Map<string, Deferred<string>>();
  const signals = new Map<string, AbortSignal>();
  const taskService = qd.defineService(task, {
    methods: {
      get: { access: "authenticated", handler: ({ input }) => row(input.id) },
      list: {
        access: "public",
        handler: ({ input }) =>
          Array.from({ length: Math.min(input.limit, 2) }, (_, index) => ({
            ...row(`t${index}`),
            done: input.done ?? false,
          })),
      },
      rename: {
        access: custom((ctx) => ctx.mcp === undefined || ctx.mcp.scopes.includes("tasks:write")),
        handler: ({ input }) => row(input.id, input.title),
      },
      whoami: {
        access: "public",
        handler: ({ ctx }) => ({
          userId: ctx.principal?.userId ?? null,
          kind: ctx.principal?.kind ?? null,
          transport: ctx.transport,
          scopes: ctx.mcp === undefined ? null : [...ctx.mcp.scopes],
        }),
      },
    },
  });
  const noteService = qd.defineService(note, {
    methods: {
      search: { access: "public", handler: ({ input }) => [`a note about ${input}`] },
      archive: {
        access: "authenticated",
        handler: ({ input }) => {
          if (input.by === "tag" && input.tag === "locked") {
            throw new QuickdrawError("CONFLICT", "Notes tagged locked cannot be archived");
          }
          return input.by === "id" ? 1 : 3;
        },
      },
      wait: {
        access: "public",
        handler: ({ input, ctx }) => {
          const gate = deferred<string>();
          gates.set(input.key, gate);
          signals.set(input.key, ctx.signal);
          return gate.promise;
        },
      },
    },
  });
  return { taskService, noteService, gates, signals };
}

export type Services = ReturnType<typeof createServices>;

type Options = Partial<
  McpRegistryOptions<readonly [Services["taskService"], Services["noteService"]]>
>;

/** A registry over a dispatcher serving both services, with a recording logger and completion records. */
export function setup(options: Options = {}, pipeline: PipelineOptions = {}) {
  const logger = captureLogger();
  const records: CallRecord[] = [];
  const services = createServices();
  const served = [services.taskService, services.noteService] as const;
  const dispatcher = createDispatcher({
    services: served,
    logger,
    onCall: (record) => records.push(record),
    ...pipeline,
  });
  const registry = createMcpRegistry({
    services: served,
    dispatcher,
    logger,
    ...agentAuth(() => "writer-token"),
    ...options,
  });
  return { registry, dispatcher, logger, records, services };
}
