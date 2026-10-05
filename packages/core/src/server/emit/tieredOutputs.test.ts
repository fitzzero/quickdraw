// The `tiered-field-in-output` development warning (finding F7.4 of the
// quickdraw-chat review): a method whose own output schema names a field the
// contract tiers is warned about when a dispatcher is made, unless its access
// admits no caller below the field's level; a strict test app fails to
// start. The reviewer's case: a user profile whose `email` is `Admin`-only,
// and an `updateUser` a service-wide `Moderate` grant may call, whose
// hand-written answer handed that grant any user's email.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { z as z3 } from "zod3";
import type { PrismaClient } from "../../../test/prisma/setup";
import { defineContract, mutation, query, type StandardSchemaV1 } from "../../index";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, DevWarningError } from "../../testing/index";
import { captureLogger } from "../__tests__/fixtures";
import { initQuickdraw, owner, type Principal } from "../index";
import { tieredOutputWarnings } from "./tieredOutputs";

const qd = initQuickdraw<{ db: PrismaClient; principal: Principal }>();
const byId = z.object({ id: z.string() });
const answer = z.object({ id: z.string(), name: z.string(), email: z.string() });
const select = { id: true, name: true, email: true } as const;
// Zod 3's own types do not meet a contract's output check: the test needs only its value.
const legacyOutput = z3.object({
  id: z3.string(),
  email: z3.string(),
}) as unknown as StandardSchemaV1<unknown, { readonly id: string; readonly email: string }>;

const userContract = defineContract("userService", {
  entity: answer,
  fields: { email: "Admin" },
  methods: {
    get: query({ input: byId, output: "entity" }),
    /** The template's shape: a hand-written answer, one branch of which names `email`. */
    updateUser: mutation({
      input: z.object({ id: z.string(), name: z.string() }),
      output: z.union([z.object({ error: z.literal("name_taken") }), answer]),
    }),
    /** The fix: the same write, answered as the entity, which is stripped per caller. */
    rename: mutation({ input: z.object({ id: z.string(), name: z.string() }), output: "entity" }),
    /** A list of rows that names `email`, open to every signed-in user. */
    directory: query({ input: z.undefined(), output: z.array(answer) }),
    adminList: query({ input: z.undefined(), output: z.array(answer) }),
    own: query({ input: byId, output: answer }),
    /** A Zod 3 schema has no JSON Schema: its keys are unknown, so it is not checked. */
    legacy: query({ input: byId, output: legacyOutput }),
  },
});

function defineUserService(adminBypass?: boolean) {
  return qd.defineService(userContract, {
    model: "user",
    // a user is Admin on their own row
    access: owner("id"),
    ...(adminBypass === undefined ? {} : { adminBypass }),
    methods: {
      get: {
        access: { entry: "Read" },
        handler: ({ input, db }) => db.user.findUniqueOrThrow({ where: { id: input.id } }),
      },
      updateUser: {
        access: { service: "Moderate", entry: "Moderate" },
        handler: ({ input, db }) =>
          db.user.update({ where: { id: input.id }, data: { name: input.name }, select }),
      },
      rename: {
        access: { service: "Moderate", entry: "Moderate" },
        handler: ({ input, db }) =>
          db.user.update({ where: { id: input.id }, data: { name: input.name } }),
      },
      directory: {
        access: "authenticated",
        handler: ({ db }) => db.user.findMany({ select, take: 50 }),
      },
      adminList: {
        access: { service: "Admin" },
        handler: ({ db }) => db.user.findMany({ select, take: 50 }),
      },
      own: {
        access: { entry: "Admin" },
        handler: ({ input, db }) => db.user.findUniqueOrThrow({ where: { id: input.id }, select }),
      },
      legacy: {
        access: { entry: "Read" },
        handler: ({ input, db }) => db.user.findUniqueOrThrow({ where: { id: input.id }, select }),
      },
    },
  });
}

describe("which methods warn", () => {
  it("names each schema output with a tiered key whose access admits callers below its level", () => {
    const warnings = tieredOutputWarnings(defineUserService());
    expect(warnings.map(({ method, subject }) => `${method}.${subject ?? ""}`)).toEqual([
      "updateUser.email",
      "directory.email",
    ]);
    expect(warnings[0]).toMatchObject({
      kind: "tiered-field-in-output",
      service: "userService",
      method: "updateUser",
      meta: { field: "email", level: "Admin" },
    });
    expect(warnings[0]?.message).toContain('Answer "entity"');
  });

  it("warns about a service-wide Admin grant too once the Admin bypass is off", () => {
    expect(tieredOutputWarnings(defineUserService(false)).map(({ method }) => method)).toEqual([
      "updateUser",
      "directory",
      "adminList",
    ]);
  });
});

describe("a dispatcher", () => {
  let h: Harness;
  let victim: { readonly id: string };
  let moderator: Principal;

  beforeAll(async () => {
    h = await createHarness();
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await h.database.reset();
    victim = await h.prisma.user.create({
      data: { email: "victim@secret.example", name: "Victim" },
    });
    const mod = await h.prisma.user.create({ data: { email: "mod@example.com", name: "Mod" } });
    moderator = { userId: mod.id, serviceAccess: { userService: "Moderate" } };
  });

  it("logs the warning once per method and key when it is made", async () => {
    const logger = captureLogger();
    const app = await createTestApp({ services: [defineUserService()], db: h.db, logger });
    try {
      const warned = logger.at("warn").map((entry) => entry.message);
      expect(warned.filter((message) => message.includes("tiered-field-in-output"))).toEqual([
        expect.stringContaining(
          '[quickdraw:tiered-field-in-output] userService.updateUser: its output schema names "email"',
        ),
        expect.stringContaining("[quickdraw:tiered-field-in-output] userService.directory:"),
      ]);
      // What it warns about: a no-op updateUser answers a Moderate grant another user's email,
      // which the entity, stripped per caller, does not.
      const asModerator = app.as(moderator);
      expect(await asModerator.userService.updateUser({ id: victim.id, name: "Victim" })).toEqual({
        id: victim.id,
        name: "Victim",
        email: "victim@secret.example",
      });
      expect(await asModerator.userService.rename({ id: victim.id, name: "Victim" })).toEqual({
        id: victim.id,
        name: "Victim",
      });
    } finally {
      await app.close();
    }
  });

  it("fails to start in a test app made with strictWarnings", async () => {
    await expect(
      createTestApp({ services: [defineUserService()], db: h.db, strictWarnings: true }),
    ).rejects.toThrow(DevWarningError);
    await expect(
      createTestApp({ services: [defineUserService()], db: h.db, strictWarnings: true }),
    ).rejects.toThrow(
      '[quickdraw:tiered-field-in-output] userService.updateUser: its output schema names "email"',
    );
  });
});
