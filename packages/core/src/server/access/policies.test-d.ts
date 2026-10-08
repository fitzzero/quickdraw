// Type tests for the access policies (RFC 0003 section 4.2) against the test
// schema's generated Prisma client: a policy's column names are checked
// against the service's model, and a membership table's against its own,
// structurally, through each model delegate's `fields`. Each
// `@ts-expect-error` sits on the line the compiler reports.

import { describe, expectTypeOf, test } from "vitest";
import type { PrismaClient } from "../../../test/prisma/setup";
import { defineContract } from "../../index";
import {
  anyOf,
  createDispatcher,
  inherit,
  initQuickdraw,
  jsonAcl,
  members,
  owner,
  resolver,
  type AccessPolicy,
  type DispatcherAccess,
  type ModelColumn,
  type ModelName,
  type RowLevels,
} from "../index";

const qd = initQuickdraw<{ db: PrismaClient }>();
const project = defineContract("projectService", { methods: {} });
const task = defineContract("taskService", { methods: {} });

const membership = {
  model: "projectMember",
  entry: "projectId",
  user: "userId",
  level: "role",
} as const;

describe("the app's models", () => {
  test("are read from the client's model delegates", () => {
    expectTypeOf<ModelName<PrismaClient>>().toEqualTypeOf<
      "user" | "project" | "projectMember" | "task" | "label" | "taskLabel" | "verificationToken"
    >();
    expectTypeOf<ModelColumn<PrismaClient, "project">>().toEqualTypeOf<
      "id" | "name" | "ownerId" | "acl" | "archived"
    >();
    expectTypeOf<ModelName<{ readonly label: string }>>().toEqualTypeOf<string>();
    expectTypeOf<ModelColumn<unknown, "task">>().toEqualTypeOf<string>();
  });

  test("a policy names the columns it reads in its type", () => {
    expectTypeOf(owner("ownerId")).toEqualTypeOf<AccessPolicy<"ownerId", never>>();
    expectTypeOf(jsonAcl("acl", { owner: "ownerId" })).toEqualTypeOf<
      AccessPolicy<"acl" | "ownerId", never>
    >();
    expectTypeOf(members(membership)).toEqualTypeOf<
      AccessPolicy<
        never,
        { readonly model: "projectMember"; readonly columns: "projectId" | "userId" | "role" }
      >
    >();
    expectTypeOf(anyOf(owner("ownerId"), jsonAcl("acl"))).toEqualTypeOf<
      AccessPolicy<"ownerId" | "acl", never>
    >();
    expectTypeOf(inherit({ from: project, via: "projectId" })).toEqualTypeOf<
      AccessPolicy<"projectId", never>
    >();
  });

  test("a resolver names what its reads declare", () => {
    const levelsFor = () => new Map();
    expectTypeOf(resolver({ levelsFor })).toEqualTypeOf<AccessPolicy<never, never>>();
    expectTypeOf(resolver({ levelsFor, reads: "none" })).toEqualTypeOf<
      AccessPolicy<never, never>
    >();
    expectTypeOf(
      resolver({ levelsFor, reads: { columns: ["ownerId", "acl"], memberships: [membership] } }),
    ).toEqualTypeOf<
      AccessPolicy<
        "ownerId" | "acl",
        { readonly model: "projectMember"; readonly columns: "projectId" | "userId" | "role" }
      >
    >();
    // A typed principal, from levelsFor's parameter, keeps the reads inferred.
    expectTypeOf(
      resolver({
        levelsFor: (principal: { readonly userId: string; readonly team: string }) =>
          new Map([[principal.team, "Read"]]),
        reads: {
          memberships: [
            { model: "projectMember", entry: "projectId", user: "userId", level: "role" },
          ],
        },
      }),
    ).toEqualTypeOf<
      AccessPolicy<
        never,
        { readonly model: "projectMember"; readonly columns: "projectId" | "userId" | "role" }
      >
    >();
  });
});

describe("defineService checks a policy against the service's model", () => {
  test("columns of the model pass", () => {
    qd.defineService(project, { model: "project", access: owner("ownerId"), methods: {} });
    qd.defineService(project, {
      model: "project",
      access: anyOf(jsonAcl("acl", { owner: "ownerId" }), members(membership)),
      methods: {},
    });
    qd.defineService(task, {
      model: "task",
      access: inherit({ from: project, via: "projectId" }),
      methods: {},
    });
    qd.defineService(task, {
      model: "task",
      access: resolver({ levelsFor: () => new Map() }),
      methods: {},
    });
  });

  test("a column the model does not have fails", () => {
    qd.defineService(project, {
      model: "project",
      // @ts-expect-error -- Project has no column "owner"
      access: owner("owner"),
      methods: {},
    });
    qd.defineService(task, {
      model: "task",
      // @ts-expect-error -- "ownerId" is a column of Project, not of Task
      access: anyOf(owner("assigneeId"), owner("ownerId")),
      methods: {},
    });
    qd.defineService(task, {
      model: "task",
      // @ts-expect-error -- Task has no column "project"
      access: inherit({ from: project, via: "project" }),
      methods: {},
    });
  });

  test("a resolver's declared columns and tables are checked too", () => {
    const levelsFor = () => new Map();
    qd.defineService(project, {
      model: "project",
      access: resolver({ levelsFor, reads: { columns: ["ownerId"], memberships: [membership] } }),
      methods: {},
    });
    qd.defineService(project, {
      model: "project",
      // @ts-expect-error -- Project has no column "owner"
      access: resolver({ levelsFor, reads: { columns: ["owner"] } }),
      methods: {},
    });
    qd.defineService(project, {
      model: "project",
      // @ts-expect-error -- ProjectMember has no column "level"
      access: resolver({ levelsFor, reads: { memberships: [{ ...membership, level: "level" }] } }),
      methods: {},
    });
    qd.defineService(task, {
      model: "task",
      // @ts-expect-error -- "ownerId" is a column of Project, not of Task
      access: anyOf(owner("assigneeId"), resolver({ levelsFor, reads: { columns: ["ownerId"] } })),
      methods: {},
    });
    // @ts-expect-error -- reads names columns and membership tables, or is "none"
    resolver({ levelsFor, reads: "all" });
  });

  test("a membership table and its columns are checked too", () => {
    qd.defineService(project, {
      model: "project",
      // @ts-expect-error -- the client has no model "member"
      access: members({ ...membership, model: "member" }),
      methods: {},
    });
    qd.defineService(project, {
      model: "project",
      // @ts-expect-error -- ProjectMember has no column "level"
      access: members({ ...membership, level: "level" }),
      methods: {},
    });
  });

  test("a model the client does not have fails", () => {
    qd.defineService(project, {
      // @ts-expect-error -- the client has no model "projects"
      model: "projects",
      methods: {},
    });
  });

  test("without a client that lists its models, any name passes", () => {
    initQuickdraw().defineService(project, {
      model: "anything",
      access: anyOf(owner("whatever"), members({ ...membership, model: "elsewhere" })),
      methods: {},
    });
  });
});

describe("dispatcher.access", () => {
  test("answers levels, filters and change events", () => {
    const service = qd.defineService(project, {
      model: "project",
      access: owner("ownerId"),
      methods: {},
    });
    const dispatcher = createDispatcher({ services: [service], db: {} as PrismaClient });
    expectTypeOf(dispatcher.access).toEqualTypeOf<DispatcherAccess>();
    expectTypeOf(dispatcher.access.levelsFor).returns.resolves.toEqualTypeOf<RowLevels>();
    expectTypeOf(dispatcher.access.levelsFor)
      .parameter(0)
      .toEqualTypeOf<import("../../index").AnyContract | string>();
  });
});
