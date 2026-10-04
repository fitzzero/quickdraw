// `everyone(level)` on a live server (finding F2.7): public profiles, which
// every signed-in user reads, by a method call and by an entity
// subscription alike (`rowless: true` on a method would cover the call
// only), while each user edits their own row.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineContract, mutation, query } from "../../index";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, emitWithAck, type TestApp } from "../../testing/index";
import { anyOf, everyone, owner } from "../index";
import { as, qd, seedBoard, type Board } from "./__tests__/board";

const profile = z.object({ id: z.string(), name: z.string() });

const profileContract = defineContract("profileService", {
  entity: profile,
  methods: {
    get: query({ input: z.object({ id: z.string() }), output: "entity" }),
    rename: mutation({ input: z.object({ id: z.string(), name: z.string() }), output: "entity" }),
  },
});

const profileService = qd.defineService(profileContract, {
  model: "user",
  access: anyOf(owner("id"), everyone("Read")),
  methods: {
    get: {
      access: { entry: "Read" },
      handler: ({ input, db }) =>
        db.user.findUniqueOrThrow({ where: { id: input.id }, select: { id: true, name: true } }),
    },
    rename: {
      access: { entry: "Admin" },
      handler: ({ input, db }) =>
        db.user.update({
          where: { id: input.id },
          data: { name: input.name },
          select: { id: true, name: true },
        }),
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

describe("everyone(level)", () => {
  it("lets every signed-in user call on and subscribe to every row, and only the owner edit theirs", async () => {
    const app = await createTestApp({ services: [profileService], db: h.db });
    apps.push(app as unknown as TestApp);
    const cy = app.as(as(board.cy)).profileService;
    expect(await cy.get({ id: board.ada })).toEqual({ id: board.ada, name: expect.any(String) });
    const socket = await app.connect(as(board.cy));
    const reply = await emitWithAck(socket.socket, "qd:sub", {
      s: "profileService",
      ids: [board.ada],
    });
    expect(reply).toMatchObject({ ok: true, r: [{ ok: true, d: { id: board.ada } }] });
    await expect(cy.rename({ id: board.ada, name: "Not yours" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await cy.rename({ id: board.cy, name: "Cy" })).toEqual({ id: board.cy, name: "Cy" });
    // No principal, no level: an anonymous socket subscribes to nothing.
    const anonymous = await app.connect(null);
    expect(
      await emitWithAck(anonymous.socket, "qd:sub", { s: "profileService", ids: [board.ada] }),
    ).toMatchObject({ ok: false, e: { code: "UNAUTHENTICATED" } });
  });
});
