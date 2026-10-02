// Definition-time checks of `defineService` and the registry. The types
// reject the same mistakes at compile time (defineService.test-d.ts); these
// catch JavaScript callers and casts.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineContract, query } from "../index";
import { project, qd, task, taskDefaults, taskRow } from "./__tests__/fixtures";
import { custom, initQuickdraw, type AnyService } from "./index";
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
    expect(() => defineLoosely(task, { methods: taskDefaults, model: "task" })).toThrow(
      'the definition has an unknown option "model"',
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
      expect(() =>
        defineLoosely(task, withMethod("count", { access, handler: () => 0 })),
      ).not.toThrow();
    }
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
