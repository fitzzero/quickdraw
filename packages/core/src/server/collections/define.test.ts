// What `defineService` and a dispatcher check about collections (RFC 0003
// section 7.1): every collection of the contract says how its scopes are
// authorized, its anchor is a served service with a policy, and only the
// columns that decide membership are registered with the storage adapter.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineContract, query, via } from "../../index";
import {
  createDispatcher,
  inherit,
  initQuickdraw,
  owner,
  type AnyService,
  type StorageAdapter,
} from "../index";
import { createInterestRegistry } from "../storage";

const qd = initQuickdraw();

const projectContract = defineContract("projectService", {
  entity: z.object({ id: z.string(), ownerId: z.string() }),
});

const projectService = qd.defineService(projectContract, {
  model: "project",
  access: owner("ownerId"),
  methods: {},
});

const taskContract = defineContract("taskService", {
  entity: z.object({
    id: z.string(),
    projectId: z.string(),
    status: z.string(),
    ordinal: z.number(),
  }),
  methods: { get: query({ input: z.object({ id: z.string() }), output: "entity" }) },
  collections: {
    open: {
      scope: "projectId",
      item: "entity",
      where: { status: "open" },
      order: [
        ["ordinal", "asc"],
        ["id", "asc"],
      ],
    },
    byLabel: {
      scope: via({ model: "TaskLabel", entry: "taskId", scope: "labelId" }),
      item: "entity",
      order: [["id", "asc"]],
    },
  },
});

const get = {
  access: "public",
  handler: () => ({ id: "t", projectId: "p", status: "open", ordinal: 0 }),
};

function defineLoosely(definition: Record<string, unknown>): AnyService {
  return (qd.defineService as (contract: unknown, definition: unknown) => AnyService)(
    taskContract,
    {
      model: "task",
      access: inherit({ from: projectContract, via: "projectId" }),
      methods: { get },
      ...definition,
    },
  );
}

const anchored = { open: { anchor: projectContract }, byLabel: { scopeAccess: "self" } };

/** A storage adapter that reads nothing and keeps the interest registered with it. */
function interestOnly(): StorageAdapter {
  const interest = createInterestRegistry();
  return {
    findMany: () => Promise.resolve([]),
    count: () => Promise.resolve(0),
    onWrite: () => () => undefined,
    countStatements: async (fn) => ({ value: await fn(), statements: 0 }),
    registerInterest: interest.register,
    interestOf: interest.of,
    unitOfWork: {
      begin: () => ({
        sqlStatements: undefined,
        run: async (fn) => await fn(),
        flush: () => Promise.resolve(),
      }),
    },
  };
}

describe("a service's collections option", () => {
  it("is required for each collection of the contract", () => {
    expect(() => defineLoosely({})).toThrow(
      `defineService("taskService"): collection "open" needs its scope's access: collections: { open: { anchor: contract } }, or { scopeAccess: "self" } for a scope that is the subscriber's user id`,
    );
    expect(() => defineLoosely({ collections: { open: { anchor: projectContract } } })).toThrow(
      'collection "byLabel" needs its scope\'s access',
    );
  });

  it("refuses an entry naming no collection, and malformed entries", () => {
    const refuses = (collections: unknown, message: string) =>
      expect(() => defineLoosely({ collections })).toThrow(message);
    refuses({ ...anchored, nope: { scopeAccess: "self" } }, 'collections names "nope"');
    refuses(
      { ...anchored, open: { anchor: projectContract, scopeAccess: "self" } },
      "collections.open needs exactly one of anchor",
    );
    refuses({ ...anchored, open: {} }, "collections.open needs exactly one of anchor");
    refuses({ ...anchored, open: { anchor: "project" } }, "anchor must be a contract");
    refuses({ ...anchored, open: { scopeAccess: "others" } }, 'scopeAccess must be "self"');
    refuses(
      { ...anchored, open: { anchor: projectContract, bulkThreshold: 0 } },
      "bulkThreshold must be a positive whole number",
    );
    refuses({ ...anchored, open: { anchor: projectContract, by: 1 } }, 'unknown option "by"');
    refuses([], "collections must map each collection");
  });

  it("needs model", () => {
    expect(() =>
      (qd.defineService as (contract: unknown, definition: unknown) => AnyService)(taskContract, {
        collections: anchored,
        methods: { get },
      }),
    ).toThrow("collections need model");
  });

  it("is compiled onto the service with the contract's limits and defaults", () => {
    const service = defineLoosely({
      collections: { ...anchored, open: { anchor: projectContract, bulkThreshold: 50 } },
    });
    expect(service.collections.get("open")).toMatchObject({
      name: "open",
      scope: { kind: "column", column: "projectId" },
      where: { status: "open" },
      limit: 100,
      maxLimit: 500,
      access: "Read",
      anchor: projectContract,
      bulkThreshold: 50,
    });
    expect(service.collections.get("byLabel")).toMatchObject({
      scope: { kind: "via", model: "TaskLabel", entry: "taskId", scope: "labelId" },
      anchor: undefined,
      bulkThreshold: 200,
    });
  });
});

describe("a dispatcher's collections", () => {
  it("need their anchor served, with a model and an access policy", () => {
    const tasks = defineLoosely({ access: undefined, collections: anchored });
    expect(() => createDispatcher({ services: [tasks], storage: interestOnly() })).toThrow(
      "createDispatcher: taskService.open is anchored on projectService, which this dispatcher does not serve",
    );
    const bare = qd.defineService(projectContract, { model: "project", methods: {} });
    expect(() => createDispatcher({ services: [tasks, bare], storage: interestOnly() })).toThrow(
      "createDispatcher: taskService.open is anchored on projectService, which declares no model and access policy",
    );
  });

  it("register the columns that decide membership, and not the order columns", () => {
    const storage = interestOnly();
    createDispatcher({
      services: [projectService, defineLoosely({ collections: anchored })],
      storage,
    });
    expect([...storage.interestOf("task")].sort()).toEqual(["projectId", "status"]);
    expect([...storage.interestOf("taskLabel")].sort()).toEqual(["labelId", "taskId"]);
  });

  it("are reset through qd.collections.reset, which needs a dispatcher", () => {
    const local = initQuickdraw();
    expect(() => local.collections.reset(taskContract, "open", "p1")).toThrow(
      "qd.collections.reset has no dispatcher to send through",
    );
    local.createDispatcher({
      services: [projectService, defineLoosely({ collections: anchored })],
      storage: interestOnly(),
    });
    expect(() => local.collections.reset(taskContract, "open", "p1")).not.toThrow();
    expect(() => local.collections.reset(taskContract, "open", "")).toThrow(
      "collections.reset: scope must be the scope's value",
    );
  });
});
