// A method's `claims` (RFC 0003 section 4.1, `claims.ts`) through a real
// server against PGlite, on the access tests' board: Ada owns P1 and T1, Ed
// owns P2 and T2, and Cy reads P1 as a member. The task service is the
// README's: `triage` needs Moderate on the task's project (`{ entry:
// "Moderate" }`) and a token whose claims say it may triage. The claims add
// to the form, so a triage token of a stranger is refused another tenant's
// task (the audit's ACCESS-1, inverted), and no grant passes them: a
// read-only token of a user with a service-wide Admin grant is refused on
// every transport (ACCESS-4), and so is it under an app's own engine.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { PrismaClient } from "../../../test/prisma/setup";
import { defineContract, mutation } from "../../index";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, type TestApp } from "../../testing/index";
import { inherit, initQuickdraw, type Principal } from "../index";
import { checkClaims } from "./claims";
import { createMcpRegistry } from "../mcp/index";
import { isPrincipal } from "../transports/auth";
import { projectContract, projectService, seedBoard, type Board } from "./__tests__/board";

const qd = initQuickdraw<{ db: PrismaClient; principal: Principal }>();

const taskContract = defineContract("taskService", {
  entity: z.object({ id: z.string(), projectId: z.string(), status: z.string() }),
  methods: {
    triage: mutation({
      input: z.object({ id: z.string(), status: z.string() }),
      output: "entity",
    }),
  },
});

const taskService = qd.defineService(taskContract, {
  model: "task",
  access: inherit({ from: projectContract, via: "projectId" }),
  methods: {
    triage: {
      // Moderate on the task's project, from a token that may triage: claims add to the form
      access: { entry: "Moderate" },
      claims: (claims, input) => claims?.scope === "triage" && input.status !== "archived",
      handler: ({ input, db }) =>
        db.task.update({ where: { id: input.id }, data: { status: input.status } }),
    },
  },
});

let h: Harness;
let board: Board;
const apps: TestApp[] = [];

beforeAll(async () => {
  h = await createHarness();
}, 60_000);

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.database.reset();
  board = await seedBoard(h.prisma);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => await app.close()));
});

/** Ed's and Ada's triage tokens, Ada herself, and Cy's tokens, with a service-wide Admin grant on tasks. */
function principals() {
  const triage = { scope: "triage" };
  const edTriage: Principal = { userId: board.ed, kind: "agent", claims: triage };
  const adaTriage: Principal = { userId: board.ada, kind: "agent", claims: triage };
  const adaPlain: Principal = { userId: board.ada, kind: "user" };
  const cyAdminReadOnly: Principal = {
    userId: board.cy,
    kind: "agent",
    claims: { scope: "read-only" },
    serviceAccess: { taskService: "Admin" },
  };
  const cyAdminTriage: Principal = { ...cyAdminReadOnly, claims: triage };
  return { edTriage, adaTriage, adaPlain, cyAdminReadOnly, cyAdminTriage };
}

/** The app: a socket's principal is the one its handshake names; an HTTP call's, its bearer token's. */
async function start() {
  const app = await createTestApp({
    services: [projectService, taskService],
    db: h.db,
    auth: {
      authenticate: ({ auth }) => {
        if (isPrincipal(auth.principal)) {
          return auth.principal;
        }
        return auth.token === "cy-read-only" ? principals().cyAdminReadOnly : null;
      },
    },
  });
  apps.push(app as unknown as TestApp);
  return app;
}

/** The status of `id` in the database. */
async function statusOf(id: string): Promise<string> {
  return (await h.prisma.task.findUniqueOrThrow({ where: { id } })).status;
}

const claimsRefusal = {
  code: "FORBIDDEN",
  message: "taskService.triage is not open to the caller's claims",
};

describe("a method's claims", () => {
  it("adds to the row check: a triage token of a stranger cannot write another tenant's task", async () => {
    const app = await start();
    const { edTriage, adaTriage } = principals();
    const done = { id: board.t1, status: "done" };
    await expect(app.as(edTriage).taskService.triage(done)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const socket = await app.connect(edTriage);
    await expect(socket.call.taskService.triage(done)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await statusOf(board.t1)).toBe("open");
    // Ada's triage token holds Moderate on P1, through her ownership.
    expect(await app.as(adaTriage).taskService.triage(done)).toMatchObject({
      id: board.t1,
      status: "done",
    });
  });

  it("refuses a caller whose claims fail the check, and an anonymous caller", async () => {
    const app = await start();
    const { adaTriage, adaPlain } = principals();
    await expect(
      app.as(adaPlain).taskService.triage({ id: board.t1, status: "done" }),
    ).rejects.toMatchObject(claimsRefusal);
    await expect(
      app.as(adaTriage).taskService.triage({ id: board.t1, status: "archived" }),
    ).rejects.toMatchObject(claimsRefusal);
    await expect(
      app.as(null).taskService.triage({ id: board.t1, status: "done" }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(await statusOf(board.t1)).toBe("open");
  });

  it("is not passed by a service-wide Admin grant, on any transport", async () => {
    const app = await start();
    const { cyAdminReadOnly, cyAdminTriage } = principals();
    const input = { id: board.t2, status: "done" };
    await expect(app.as(cyAdminReadOnly).taskService.triage(input)).rejects.toMatchObject(
      claimsRefusal,
    );
    // Over a socket.
    const socket = await app.connect(cyAdminReadOnly);
    await expect(socket.call.taskService.triage(input)).rejects.toMatchObject(claimsRefusal);
    // Over HTTP.
    const response = await fetch(`${app.url}/qd/taskService/triage`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer cy-read-only" },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, e: claimsRefusal });
    // Through the MCP bridge.
    const registry = createMcpRegistry({
      services: [taskService],
      dispatcher: app.server.dispatcher,
      principal: () => cyAdminReadOnly,
    });
    const request = { transport: "stdio", sessionId: "s1" } as const;
    expect(await registry.call("taskService_triage", input, { request })).toMatchObject({
      ok: false,
      error: claimsRefusal,
    });
    expect(await statusOf(board.t2)).toBe("open");
    // The grant passes the entry form, and a triage token passes the claims.
    expect(await app.as(cyAdminTriage).taskService.triage(input)).toMatchObject({
      id: board.t2,
      status: "done",
    });
  });

  it("is not skipped by an app's own access engine", async () => {
    const dispatcher = qd.createDispatcher({
      services: [projectService, taskService],
      db: h.db,
      access: { authorize: () => undefined },
    });
    const { cyAdminReadOnly, adaTriage } = principals();
    await expect(
      dispatcher.caller(cyAdminReadOnly).taskService.triage({ id: board.t2, status: "done" }),
    ).rejects.toMatchObject(claimsRefusal);
    expect(await statusOf(board.t2)).toBe("open");
    expect(
      await dispatcher.caller(adaTriage).taskService.triage({ id: board.t2, status: "done" }),
    ).toMatchObject({ id: board.t2, status: "done" });
  });
});

describe("a claims check that breaks the types", () => {
  const principal: Principal = { userId: "u1", claims: { scope: "triage" } };

  it("fails closed with INTERNAL when it returns a promise, and its rejection is observed", async () => {
    const rejecting = (() => Promise.reject(new Error("no claims"))) as unknown as () => boolean;
    expect(() => checkClaims(rejecting, principal, {}, "taskService.triage")).toThrow(
      expect.objectContaining({ code: "INTERNAL" }),
    );
    const resolving = (() => Promise.resolve(true)) as unknown as () => boolean;
    expect(() => checkClaims(resolving, principal, {}, "taskService.triage")).toThrow(
      expect.objectContaining({ code: "INTERNAL" }),
    );
    // An unhandled rejection would fail the run here.
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  });

  it("is refused when it is defined as an async function", () => {
    const define = qd.defineService as unknown as (
      contract: unknown,
      definition: unknown,
    ) => unknown;
    expect(() =>
      define(taskContract, {
        model: "task",
        access: inherit({ from: projectContract, via: "projectId" }),
        methods: {
          triage: { access: { entry: "Moderate" }, claims: async () => true, handler: () => null },
        },
      }),
    ).toThrow('method "triage": claims must be synchronous');
  });
});
