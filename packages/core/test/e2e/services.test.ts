// `ctx.services` (RFC 0003 sections 3 and 10) against the fixture app: a
// planner service of this test calls the fixture's task service in process,
// as the caller, through the same pipeline. The inner calls check access
// themselves, their writes join the planner's unit of work (one flush for
// both creates), and they are cancelled with the planner's `ctx.signal`.

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineContract, mutation, query } from "../../src/index";
import { qd } from "../../src/server/emit/__tests__/live";
import { createRecordingSink } from "../../src/testing/index";
import { as, e2eApp, tick } from "../fixtures/app";

const e2e = e2eApp();

const planner = defineContract("plannerService", {
  methods: {
    /** Creates a task per title in the project, then counts the project's tasks. */
    plan: mutation({
      input: z.object({ projectId: z.string(), titles: z.array(z.string()) }),
      output: z.object({ ids: z.array(z.string()), count: z.number() }),
    }),
    /** Asks the slow service, which holds until it is cancelled. */
    relay: query({ input: z.object({}), output: z.string() }),
  },
});

const slow = defineContract("slowService", {
  methods: { hold: query({ input: z.object({}), output: z.string() }) },
});

/** What the slow service's handler saw: whether its ctx.signal aborted. */
const held: { aborted?: boolean } = {};
let started: () => void = () => undefined;

/** `app.as(...)` for the planner: the fixture app's type covers its own services only. */
interface PlannerCaller {
  readonly plannerService: {
    plan(input: { projectId: string; titles: string[] }): Promise<{ ids: string[]; count: number }>;
    relay(input: object, options?: { signal?: AbortSignal }): Promise<string>;
  };
}

/** The fixture app's `qd` declares no contracts, so `ctx.services` is untyped here. */
interface Services {
  readonly taskService: {
    create(input: { projectId: string; title: string }): Promise<{ id: string }>;
    countOnBoard(input: { projectId: string }): Promise<number>;
  };
  readonly slowService: { hold(input: object): Promise<string> };
}

const plannerService = qd.defineService(planner, {
  methods: {
    plan: {
      access: "authenticated",
      handler: async ({ input, ctx }) => {
        const services = ctx.services as unknown as Services;
        const ids: string[] = [];
        for (const title of input.titles) {
          ids.push((await services.taskService.create({ projectId: input.projectId, title })).id);
        }
        const count = await services.taskService.countOnBoard({ projectId: input.projectId });
        return { ids, count };
      },
    },
    relay: {
      access: "authenticated",
      handler: async ({ ctx }) => await (ctx.services as unknown as Services).slowService.hold({}),
    },
  },
});

const slowService = qd.defineService(slow, {
  methods: {
    hold: {
      access: "authenticated",
      handler: async ({ ctx }) => {
        started();
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        held.aborted = ctx.signal.aborted;
        return "released";
      },
    },
  },
});

describe("ctx.services", () => {
  it("calls another service's mutation and query as the caller, with one flush for both writes", async () => {
    const sink = createRecordingSink();
    const { app, records } = await e2e.start({
      services: [plannerService, slowService],
      flushSink: sink,
    });
    const board = e2e.board();
    const before = await e2e.prisma().task.count({ where: { projectId: board.p1 } });

    const result = await (app.as(as(board.bo)) as unknown as PlannerCaller).plannerService.plan({
      projectId: board.p1,
      titles: ["First", "Second"],
    });
    expect(result.ids).toHaveLength(2);
    expect(result.count).toBe(before + 2);
    const rows = await e2e.prisma().task.findMany({ where: { id: { in: result.ids } } });
    expect(rows.map((row) => row.title).sort()).toEqual(["First", "Second"]);

    // The inner calls ran the pipeline in process, as bo.
    expect(
      records.map(
        (record) => `${record.service}.${record.method} ${record.transport} ${record.outcome}`,
      ),
    ).toEqual([
      "taskService.create internal ok",
      "taskService.create internal ok",
      "taskService.countOnBoard internal ok",
      "plannerService.plan internal ok",
    ]);
    // Both creates joined the planner's unit of work: one flush holds them.
    await vi.waitFor(() => expect(sink.flushes).toHaveLength(1));
    expect(
      sink
        .writes()
        .filter((write) => write.model === "task")
        .map((write) => `${write.op} ${write.id}`)
        .sort(),
    ).toEqual(result.ids.map((id) => `create ${id}`).sort());
  });

  it("checks access on the inner call: a reader cannot create through the planner", async () => {
    const { app } = await e2e.start({ services: [plannerService, slowService] });
    const board = e2e.board();
    const before = await e2e.prisma().task.count();
    // cy only reads P1, and create needs Moderate on the project.
    await expect(
      (app.as(as(board.cy)) as unknown as PlannerCaller).plannerService.plan({
        projectId: board.p1,
        titles: ["Nope"],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await e2e.prisma().task.count()).toBe(before);
  });

  it("cancels the inner call with the caller's ctx.signal", async () => {
    const { app } = await e2e.start({ services: [plannerService, slowService] });
    const board = e2e.board();
    const holding = new Promise<void>((resolve) => {
      started = resolve;
    });
    const controller = new AbortController();
    const relayed = (app.as(as(board.bo)) as unknown as PlannerCaller).plannerService
      .relay({}, { signal: controller.signal })
      .catch((reason: unknown) => reason);
    await holding;
    controller.abort();
    expect(await relayed).toMatchObject({ code: "CANCELLED" });
    await tick(10);
    expect(held.aborted).toBe(true);
  });
});
