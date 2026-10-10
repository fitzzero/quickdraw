// Definition-time checks of `defineService` and the registry. The types
// reject the same mistakes at compile time (defineService.test-d.ts); these
// catch JavaScript callers and casts.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineContract, query, todoSchema } from "../index";
import { z as z3 } from "zod3";
import {
  project,
  qd,
  task,
  taskDefaults,
  taskRow,
  taskSchema,
  type AppPrincipal,
  type FakeDb,
} from "./__tests__/fixtures";
import { custom, inherit, initQuickdraw, owner, type AnyService } from "./index";
import { createRegistry } from "./registry";

/** Calls defineService the way untyped JavaScript would. */
function defineLoosely(contract: unknown, definition: unknown): AnyService {
  const define = qd.defineService as unknown as (
    contract: unknown,
    definition: unknown,
  ) => AnyService;
  return define(contract, definition);
}

function withMethod(name: string, entry: unknown): unknown {
  return { methods: { ...taskDefaults, [name]: entry } };
}

describe("defineService", () => {
  it("returns a frozen service with one checked record per method", () => {
    const service = qd.defineService(task, {
      methods: {
        ...taskDefaults,
        list: { access: "public", share: "all", ttlMs: 50, handler: () => [] },
        count: { access: "authenticated", timeoutMs: 100, version: () => 1, handler: () => 0 },
      },
    });
    expect(service.name).toBe("taskService");
    expect(service.contract).toBe(task);
    expect(service.adminBypass).toBe(true);
    expect(Object.isFrozen(service)).toBe(true);
    expect(Object.keys(service.methods).sort()).toEqual(["count", "find", "get", "list", "rename"]);
    expect(service.methods.list).toMatchObject({
      kind: "query",
      share: "all",
      ttlMs: 50,
      access: "public",
    });
    expect(service.methods.count).toMatchObject({ timeoutMs: 100, share: undefined });
    expect(service.methods.rename).toMatchObject({ kind: "mutation", access: "authenticated" });
    expect(qd.defineService(task, { methods: taskDefaults, adminBypass: false }).adminBypass).toBe(
      false,
    );
  });

  it("derives the output schema from the method's output", async () => {
    const service = qd.defineService(task, { methods: taskDefaults });
    const check = async (method: string, value: unknown) =>
      (await service.methods[method]?.output["~standard"].validate(value))?.issues === undefined;
    expect(await check("get", taskRow())).toBe(true);
    expect(await check("get", null)).toBe(false);
    expect(await check("find", null)).toBe(true);
    expect(await check("find", taskRow())).toBe(true);
    expect(await check("list", [{ id: "t1", title: "card" }])).toBe(true);
    expect(await check("list", { id: "t1" })).toBe(false);
    expect(await check("count", 3)).toBe(true);
    expect(await check("count", "3")).toBe(false);
  });

  it("requires exactly the contract's methods", () => {
    const { count: _count, ...missingCount } = taskDefaults;
    expect(() => defineLoosely(task, { methods: missingCount })).toThrow(
      'defineService("taskService"): methods has no implementation for "count"',
    );
    expect(() => defineLoosely(task, withMethod("archive", taskDefaults.rename))).toThrow(
      '"archive" is not a method of the contract',
    );
    expect(() => defineLoosely(task, {})).toThrow("methods must be an object");
    expect(() => defineLoosely(task, { methods: taskDefaults, relations: ["taskLabel"] })).toThrow(
      'the definition has an unknown option "relations"',
    );
    expect(() => defineLoosely({ name: "taskService" }, { methods: {} })).toThrow(
      "the first argument must be a contract from defineContract",
    );
  });

  it("requires an access form and a handler on every method", () => {
    const problems: [unknown, string][] = [
      [{ handler: () => 0 }, 'access must be "public"'],
      [{ access: "anyone", handler: () => 0 }, 'access must be "public"'],
      [{ access: { service: "Owner" }, handler: () => 0 }, "set to an access level"],
      [{ access: { entry: "Read", of: project }, handler: () => 0 }, "of belongs to scope forms"],
      [
        { access: { service: "Read", id: "projectId" }, handler: () => 0 },
        "id belongs to entry and scope forms",
      ],
      [
        { access: { scope: "Read", id: "projectId" }, handler: () => 0 },
        "a scope form is { scope, of: contract, id }",
      ],
      [
        { access: { scope: "Read", entry: "Read", of: project, id: "x" }, handler: () => 0 },
        "a scope form",
      ],
      [{ access: { entry: "Read", level: "Read" }, handler: () => 0 }, 'unknown key "level"'],
      [{ access: { kind: "custom" }, handler: () => 0 }, "custom access needs a check function"],
      [{ access: "public" }, "needs a handler function"],
      [{ access: "public", handler: () => 0, timeoutMs: 0 }, "timeoutMs must be a positive number"],
      [{ access: "public", handler: () => 0, timeoutMs: 2 ** 31 }, "at most 2147483647"],
      [{ access: "public", handler: () => 0, cache: true }, 'unknown option "cache"'],
      ["public", "must be { access, handler }"],
    ];
    for (const [entry, message] of problems) {
      expect(() => defineLoosely(task, withMethod("count", entry)), JSON.stringify(entry)).toThrow(
        message,
      );
    }
    for (const access of [
      "public",
      "authenticated",
      { service: "Read" },
      { entry: "Read", id: "projectId" },
      {
        service: "Admin",
        entry: "Moderate",
        id: (input: { projectId: string }) => input.projectId,
      },
      { scope: "Read", of: project, id: "projectId" },
      custom(() => true),
    ]) {
      const definition = withMethod("count", { access, handler: () => 0 }) as object;
      expect(() =>
        defineLoosely(task, { model: "task", access: owner("ownerId"), ...definition }),
      ).not.toThrow();
    }
  });

  it("checks model and access, and allows row-level forms only where they can be decided", () => {
    const policy = inherit({ from: project, via: "projectId" });
    const rename = (access: unknown) => withMethod("rename", { access, handler: () => taskRow() });
    const service = defineLoosely(task, { model: "task", access: policy, methods: taskDefaults });
    expect(service).toMatchObject({ model: "task", access: policy });
    expect(qd.defineService(task, { methods: taskDefaults })).toMatchObject({
      model: undefined,
      access: undefined,
    });
    const problems: [unknown, string][] = [
      [{ model: "", methods: taskDefaults }, "model must be the database model"],
      [{ model: 3, methods: taskDefaults }, "model must be the database model"],
      [
        { model: "task", access: { kind: "owner" }, methods: taskDefaults },
        "access must be an access policy",
      ],
      [{ access: policy, methods: taskDefaults }, "access needs model"],
      [rename({ entry: "Moderate" }), 'method "rename" uses entry access, which needs'],
      [{ model: "task", ...(rename({ entry: "Moderate" }) as object) }, "uses entry access"],
      [
        rename({ service: "Admin", entry: "Moderate" }),
        'method "rename" uses entry access, which needs the service\'s access policy',
      ],
      [
        withMethod("list", {
          access: { scope: "Read", of: project, id: "projectId" },
          handler: () => [],
        }),
        'method "list" uses scope access, but the service declares no model',
      ],
    ];
    for (const [definition, message] of problems) {
      expect(() => defineLoosely(task, definition), JSON.stringify(definition)).toThrow(message);
    }
    expect(() =>
      defineLoosely(task, {
        model: "task",
        ...(withMethod("list", {
          access: { scope: "Read", of: project, id: "projectId" },
          handler: () => [],
        }) as object),
      }),
    ).not.toThrow();
  });

  it("keeps share, ttlMs and version to queries, and share all away from custom access", () => {
    const problems: [string, unknown, string][] = [
      ["rename", { access: "authenticated", share: "caller", handler: () => 0 }, "is a mutation"],
      ["rename", { access: "authenticated", version: () => 1, handler: () => 0 }, "is a mutation"],
      [
        "count",
        { access: "public", share: "everyone", handler: () => 0 },
        'share must be "caller" or "all"',
      ],
      [
        "count",
        { access: custom(() => true), share: "all", handler: () => 0 },
        'cannot share: "all"',
      ],
      ["count", { access: "public", ttlMs: 10, handler: () => 0 }, "ttlMs needs share"],
      [
        "count",
        { access: "public", share: "all", ttlMs: -1, handler: () => 0 },
        "ttlMs needs share",
      ],
      ["count", { access: "public", version: 3, handler: () => 0 }, "version must be a function"],
    ];
    for (const [method, entry, message] of problems) {
      expect(() => defineLoosely(task, withMethod(method, entry))).toThrow(message);
    }
    expect(() =>
      defineLoosely(
        task,
        withMethod("count", { access: custom(() => true), share: "caller", handler: () => 0 }),
      ),
    ).not.toThrow();
  });

  it("checks adminBypass and the context option", () => {
    expect(() => defineLoosely(task, { methods: taskDefaults, adminBypass: "yes" })).toThrow(
      "adminBypass must be a boolean",
    );
    const init = initQuickdraw as unknown as (options: unknown) => unknown;
    expect(() => init({ context: "tenant" })).toThrow("context must be a function");
    expect(() => init("options")).toThrow("options must be an object");
  });
});

describe("the rowless check", () => {
  const policy = owner("ownerId");
  /** A task service with `name` implemented by `entry`, the others by `taskDefaults`. */
  const withEntry = (name: string, entry: object, policed = true): (() => AnyService) => {
    const definition = withMethod(name, entry) as object;
    return () =>
      defineLoosely(task, policed ? { model: "task", access: policy, ...definition } : definition);
  };
  const refusal = "takes a row id (its input has id), but its access";

  it("refuses an id-taking method whose form checks no row, on a service with a policy, unless it is rowless", () => {
    const forms = ["authenticated", "public", { service: "Read" }, { service: "Moderate" }];
    const methods = [
      ["rename", true],
      ["get", true],
      ["count", false],
    ] as const;
    const cases = forms.flatMap((access) =>
      methods.flatMap(([name, takesId]) =>
        [true, false].flatMap((policed) =>
          [false, true].map((rowless) => ({ access, name, takesId, policed, rowless })),
        ),
      ),
    );
    expect(cases).toHaveLength(48);
    for (const { access, name, takesId, policed, rowless } of cases) {
      const entry = { access, handler: () => taskRow(), ...(rowless ? { rowless } : {}) };
      const define = withEntry(name, entry, policed);
      const label = JSON.stringify({ access, name, policed, rowless });
      if (takesId && policed && !rowless) {
        expect(define, label).toThrow(`method "${name}" ${refusal}`);
      } else {
        expect(define, label).not.toThrow();
      }
    }
  });

  it("names the form, who it lets in, and the two ways out", () => {
    expect(withEntry("rename", { access: "authenticated", handler: () => taskRow() })).toThrow(
      'defineService("taskService"): method "rename" takes a row id (its input has id), but its access "authenticated" checks no row: ' +
        "on a service with an access policy, that lets every signed-in user reach any row by its id. " +
        'Give it { entry: "Moderate" } so the policy decides, or, if every caller its access admits may reach any row, set rowless: true on the method',
    );
    expect(withEntry("get", { access: "public", handler: () => taskRow() })).toThrow(
      'access "public" checks no row: on a service with an access policy, that lets anyone, signed in or not, reach any row by its id. Give it { entry: "Read" }',
    );
    expect(withEntry("get", { access: { service: "Moderate" }, handler: () => taskRow() })).toThrow(
      'access { service: "Moderate" } checks no row: on a service with an access policy, that lets everyone with a service-wide Moderate grant reach any row by its id. Give it { service: "Moderate", entry: "Moderate" }',
    );
  });

  it("leaves alone the forms that check a row or decide for themselves, and Admin grants", () => {
    for (const access of [
      { service: "Admin" },
      { entry: "Read" },
      { service: "Read", entry: "Read" },
      { entry: "Read", id: "id" },
      { scope: "Read", of: project, id: "id" },
      custom(() => true),
    ]) {
      expect(
        withEntry("get", { access, handler: () => taskRow() }),
        JSON.stringify(access),
      ).not.toThrow();
    }
  });

  it("finds the id in any branch of a union and beside values JSON Schema cannot write", () => {
    /** Defines a service whose one method `m` takes `input` under `"authenticated"`. */
    const defineWith = (input: z.ZodType) => () =>
      defineLoosely(
        defineContract("probeService", {
          entity: taskSchema,
          methods: { m: query({ input, output: z.null() }) },
        }),
        {
          model: "task",
          access: policy,
          methods: { m: { access: "authenticated", handler: () => null } },
        },
      );
    const id = z.object({ id: z.string() });
    const refused: Record<string, z.ZodType> = {
      "{ id }": id,
      "{ id, at: z.date() }": id.extend({ at: z.date() }),
      "{ id, at: z.coerce.date() }": id.extend({ at: z.coerce.date() }),
      "{ id, tags: z.set() }": id.extend({ tags: z.set(z.string()) }),
      "{ id, n: z.bigint() }": id.extend({ n: z.bigint() }),
      "{ id: z.custom() }": z.object({ id: z.custom<string>((v) => typeof v === "string") }),
      "{ id: z.string().transform() }": z.object({ id: z.string().transform((s) => s.trim()) }),
      "{ id }.transform()": id.transform((v) => v),
      "{ id }.nullable()": id.nullable(),
      "{ id }.optional()": id.optional(),
      "z.union, id in both": z.union([id, id.extend({ slug: z.string() })]),
      "z.union, id in one": z.union([z.object({ slug: z.string() }), id]),
      "z.union of a union, nullable": z.union([id, z.object({ x: z.number() })]).nullable(),
      "z.discriminatedUnion": z.discriminatedUnion("kind", [
        id.extend({ kind: z.literal("a") }),
        z.object({ kind: z.literal("b"), slug: z.string() }),
      ]),
      "z.intersection": z.intersection(id, z.object({ x: z.number() })),
      "a named branch ($ref)": z.union([id.meta({ id: "ById" }), z.object({ slug: z.string() })]),
      "z.lazy": z.lazy(() => id),
      "z.preprocess": z.preprocess((v) => v, id),
    };
    for (const [label, input] of Object.entries(refused)) {
      expect(defineWith(input), label).toThrow(`method "m" ${refusal}`);
    }
    // Not checked: no object at the top (the id itself), or the row named another way.
    const unchecked: Record<string, z.ZodType> = {
      "z.string()": z.string(),
      "{ ids: string[] }": z.object({ ids: z.array(z.string()) }),
      "{ where: { id } }": z.object({ where: id }),
      "z.record()": z.record(z.string(), z.string()),
    };
    for (const [label, input] of Object.entries(unchecked)) {
      expect(defineWith(input), label).not.toThrow();
    }
  });

  it("cannot read the keys of an input without JSON Schema (Zod 3), so it does not refuse it", () => {
    const zod3 = defineContract("taskService", {
      entity: taskSchema,
      methods: { get: query({ input: z3.object({ id: z3.string() }), output: "entity" }) },
    });
    const get = { access: "authenticated", handler: () => taskRow() };
    expect(() =>
      defineLoosely(zod3, { model: "task", access: policy, methods: { get } }),
    ).not.toThrow();
  });

  it("reads a todoSchema's keys, so a keyed placeholder is refused like Zod 4 and a keyless one is not", () => {
    /** Defines a task service whose `get` takes `input` under `"authenticated"`. */
    const defineWith = (input: Parameters<typeof query>[0]["input"]) => () =>
      defineLoosely(
        defineContract("taskService", {
          entity: taskSchema,
          methods: { get: query({ input, output: "entity" }) },
        }),
        {
          model: "task",
          access: policy,
          methods: { get: { access: "authenticated", handler: () => taskRow() } },
        },
      );
    /** The message `define` throws, or undefined when it defines the service. */
    const refusalOf = (define: () => unknown): string | undefined => {
      try {
        define();
      } catch (error) {
        return (error as Error).message;
      }
      return undefined;
    };
    const zod4 = refusalOf(defineWith(z.object({ id: z.string() })));
    expect(zod4).toContain(`method "get" ${refusal}`);
    expect(refusalOf(defineWith(todoSchema<{ id: string }>({ keys: ["id"] })))).toBe(zod4);
    expect(
      refusalOf(defineWith(todoSchema<{ id: string; name: string }>({ keys: ["id", "name"] }))),
    ).toBe(zod4);
    expect(refusalOf(defineWith(todoSchema<{ id: string }>()))).toBeUndefined();
    expect(refusalOf(defineWith(todoSchema<{ id: string }>({ keys: [] })))).toBeUndefined();
  });

  it("stores rowless on the method, and takes only a boolean", () => {
    const service = withEntry("rename", {
      access: "authenticated",
      rowless: true,
      handler: () => taskRow(),
    })();
    expect(service.methods.rename?.rowless).toBe(true);
    expect(service.methods.count?.rowless).toBe(false);
    expect(
      withEntry("rename", { access: "authenticated", rowless: "yes", handler: () => 0 }),
    ).toThrow('method "rename": rowless must be true, or left out');
  });
});

describe("principal kinds", () => {
  /** An instance whose services admit only `kinds` by default. */
  const admitting = (kinds: readonly string[]) =>
    initQuickdraw<{ db: FakeDb; principal: AppPrincipal }>({
      kinds: kinds as AppPrincipal["kind"][],
    });
  /** Calls `instance.defineService` the way untyped JavaScript would. */
  const defineOn = (instance: ReturnType<typeof admitting>, definition: unknown) =>
    (instance.defineService as unknown as (contract: unknown, definition: unknown) => AnyService)(
      task,
      definition,
    );
  const rename = (kinds: unknown) => ({ ...taskDefaults.rename, kinds });

  it("gives each method its own kinds, else its service's, else the app's, and none by default", () => {
    const open = qd.defineService(task, { methods: taskDefaults });
    expect(open.kinds).toBeUndefined();
    expect(open.methods.rename?.kinds).toBeUndefined();
    const app = admitting(["user", "agent"]);
    const byApp = app.defineService(task, {
      methods: { ...taskDefaults, rename: { ...taskDefaults.rename, kinds: ["user"] } },
    });
    expect(byApp.kinds).toEqual(["user", "agent"]);
    expect(byApp.methods.count?.kinds).toEqual(["user", "agent"]);
    expect(byApp.methods.rename?.kinds).toEqual(["user"]);
    const byService = app.defineService(task, { kinds: ["agent"], methods: taskDefaults });
    expect(byService.kinds).toEqual(["agent"]);
    expect(byService.methods.rename?.kinds).toEqual(["agent"]);
    // A public method keeps the service's list: it holds for signed-in callers.
    expect(byService.methods.get?.kinds).toEqual(["agent"]);
    const repeated = qd.defineService(task, { kinds: ["user", "user"], methods: taskDefaults });
    expect(repeated.kinds).toEqual(["user"]);
    expect(Object.isFrozen(repeated.kinds)).toBe(true);
  });

  it("refuses a list that is empty or holds anything but kind names, at every level", () => {
    const message = "kinds must be a non-empty list of principal kinds (strings)";
    for (const kinds of [[], [""], ["user", 1], "user", { user: true }, null]) {
      const label = JSON.stringify(kinds);
      expect(() => defineLoosely(task, { kinds, methods: taskDefaults }), label).toThrow(
        `defineService("taskService"): ${message}`,
      );
      expect(() => defineLoosely(task, withMethod("rename", rename(kinds))), label).toThrow(
        `defineService("taskService"): method "rename": ${message}`,
      );
      const init = initQuickdraw as unknown as (options: unknown) => unknown;
      expect(() => init({ kinds }), label).toThrow(`initQuickdraw: ${message}`);
    }
  });

  it("refuses a list wider than the one above it, naming that list", () => {
    const app = admitting(["user", "agent"]);
    expect(() => defineOn(app, { kinds: ["user", "runner"], methods: taskDefaults })).toThrow(
      `defineService("taskService"): kinds may only narrow the kinds initQuickdraw admits (user, agent), and "runner" is not one of them`,
    );
    expect(() =>
      defineOn(app, { kinds: ["user"], methods: { ...taskDefaults, rename: rename(["agent"]) } }),
    ).toThrow(
      `defineService("taskService"): method "rename": kinds may only narrow the kinds its service admits (user), and "agent" is not one of them`,
    );
    expect(() =>
      defineOn(admitting(["user"]), { methods: { ...taskDefaults, rename: rename(["agent"]) } }),
    ).toThrow(
      `method "rename": kinds may only narrow the kinds its service admits (user), and "agent" is not one of them`,
    );
    expect(() =>
      defineOn(app, { kinds: ["agent"], methods: { ...taskDefaults, rename: rename(["agent"]) } }),
    ).not.toThrow();
  });

  it("refuses kinds on a public method, which a refused caller would call signed out", () => {
    expect(() =>
      defineLoosely(
        task,
        withMethod("count", { access: "public", kinds: ["user"], handler: () => 0 }),
      ),
    ).toThrow(
      'method "count" is "public", so kinds cannot narrow who may call it: a caller of a kind it left out would call it signed out',
    );
    expect(() =>
      defineLoosely(
        task,
        withMethod("count", { access: "authenticated", kinds: ["user"], handler: () => 0 }),
      ),
    ).not.toThrow();
  });
});

describe("createRegistry", () => {
  const empty = defineContract("emptyService", {
    methods: { ping: query({ input: z.undefined(), output: z.literal("pong") }) },
  });

  it("finds methods by service and method name", () => {
    const service = qd.defineService(task, { methods: taskDefaults });
    const pinger = qd.defineService(empty, {
      methods: { ping: { access: "public", handler: () => "pong" } },
    });
    const registry = createRegistry([service, pinger]);
    expect(registry.find("taskService", "rename")).toEqual({
      service,
      method: service.methods.rename,
    });
    expect(registry.find("emptyService", "ping")?.method.kind).toBe("query");
    expect(registry.find("taskService", "ping")).toBeUndefined();
    expect(registry.find("taskService", "constructor")).toBeUndefined();
    expect(registry.find("nope", "get")).toBeUndefined();
    expect([...registry.services.keys()]).toEqual(["taskService", "emptyService"]);
  });

  it("refuses two services with one name, and anything defineService did not return", () => {
    const first = qd.defineService(task, { methods: taskDefaults });
    const second = qd.defineService(task, { methods: taskDefaults });
    expect(() => createRegistry([first, second])).toThrow('two services are named "taskService"');
    expect(() => createRegistry([{ ...first }])).toThrow(
      "every service must come from qd.defineService",
    );
    expect(() => createRegistry("services" as unknown as AnyService[])).toThrow("must be an array");
  });
});
