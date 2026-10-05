// Tiered fields and schema outputs (finding F7.4 of the quickdraw-chat
// review, and item B of the final review of the release candidates): a
// schema output is sent as its schema declares it, so a handler that returns
// the whole row sends only the schema's keys; a method whose own output
// schema declares a field the contract tiers, at any depth, is warned about
// when a dispatcher is made, unless its access admits no caller below the
// field's level, and a strict test app fails to start; an output without
// JSON Schema is checked at reply time instead. The reviewers' cases: a user
// profile whose `email` is `Admin`-only, an `updateUser` a service-wide
// `Moderate` grant may call, whose hand-written answer handed that grant any
// user's email, and a `rename` whose schema left `email` out while its
// handler returned the whole row.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { z as z3 } from "zod3";
import type { PrismaClient } from "../../../test/prisma/setup";
import { crud, defineContract, mutation, query, type StandardSchemaV1 } from "../../index";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, DevWarningError } from "../../testing/index";
import { captureLogger } from "../__tests__/fixtures";
import { crud as crudHandlers, initQuickdraw, owner, type Principal } from "../index";
import { isPrincipal } from "../transports/auth";
import { tieredOutputWarnings } from "./tieredOutputs";

const qd = initQuickdraw<{ db: PrismaClient; principal: Principal }>();
const byId = z.object({ id: z.string() });
const answer = z.object({ id: z.string(), name: z.string(), email: z.string() });
const profile = z.object({ id: z.string(), name: z.string() });
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
    /** A Zod 3 schema has no JSON Schema: it cannot be reduced, so its replies are checked. */
    legacy: query({ input: byId, output: legacyOutput }),
    /** The final review's case: the schema leaves `email` out, the handler returns the whole row. */
    profile: mutation({ input: z.object({ id: z.string(), name: z.string() }), output: profile }),
    /** The row nested one level down, its schema naming `email`. */
    lookup: query({ input: byId, output: z.object({ user: answer, ok: z.boolean() }) }),
    /** The same nesting without `email` in the schema. */
    card: query({ input: byId, output: z.object({ user: profile, ok: z.boolean() }) }),
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
      profile: {
        // a service-wide Moderate grant renames anyone, as the template's updateUser does
        access: { service: "Moderate" },
        rowless: true,
        handler: ({ input, db }) =>
          db.user.update({ where: { id: input.id }, data: { name: input.name } }),
      },
      lookup: {
        access: { service: "Moderate" },
        rowless: true,
        handler: async ({ input, db }) => ({
          ok: true,
          user: await db.user.findUniqueOrThrow({ where: { id: input.id } }),
        }),
      },
      card: {
        access: { service: "Moderate" },
        rowless: true,
        handler: async ({ input, db }) => ({
          ok: true,
          user: await db.user.findUniqueOrThrow({ where: { id: input.id } }),
        }),
      },
    },
  });
}

describe("which methods warn", () => {
  it("names each schema output declaring a tiered key, at any depth, whose access admits callers below its level", () => {
    const warnings = tieredOutputWarnings(defineUserService());
    expect(warnings.map(({ method, subject }) => `${method}.${subject ?? ""}`)).toEqual([
      "updateUser.email",
      "directory.email",
      "lookup.email",
    ]);
    expect(warnings[0]).toMatchObject({
      kind: "tiered-field-in-output",
      service: "userService",
      method: "updateUser",
      meta: { field: "email", level: "Admin", path: "email" },
    });
    expect(warnings[0]?.message).toContain('Answer "entity"');
    expect(warnings[0]?.message).toContain('or drop "email" from the schema');
    expect(warnings[1]?.meta).toMatchObject({ path: "[].email" });
    expect(warnings[2]?.message).toContain('its output schema names "email" (at user.email)');
  });

  it("warns about a service-wide Admin grant too once the Admin bypass is off", () => {
    expect(tieredOutputWarnings(defineUserService(false)).map(({ method }) => method)).toEqual([
      "updateUser",
      "directory",
      "adminList",
      "lookup",
    ]);
  });

  it("leaves a kit's methods alone: a kit strips what its readers may not see itself", () => {
    const people = defineContract("peopleService", {
      entity: answer,
      fields: { email: "Admin" },
      methods: {
        ...crud.contract({ entity: answer, list: { filter: ["name"], sort: ["name"] } }),
      },
    });
    const service = qd.defineService(people, {
      model: "user",
      access: owner("id"),
      methods: { ...crudHandlers.handlers(people, { access: { list: "authenticated" } }) },
    });
    expect(tieredOutputWarnings(service)).toEqual([]);
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
        expect.stringContaining(
          '[quickdraw:tiered-field-in-output] userService.lookup: its output schema names "email" (at user.email)',
        ),
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

  it("sends a schema output as its schema declares it, on every transport, whatever the handler returned", async () => {
    await h.prisma.user.update({
      where: { id: victim.id },
      data: { serviceAccess: { userService: "Admin" } },
    });
    const app = await createTestApp({
      services: [defineUserService()],
      db: h.db,
      logger: captureLogger(),
      auth: {
        authenticate: ({ auth }) =>
          isPrincipal(auth.principal) ? auth.principal : auth.token === "mod" ? moderator : null,
      },
    });
    try {
      const renamed = { id: victim.id, name: "V2" };
      expect(await app.as(moderator).userService.profile(renamed)).toEqual(renamed);
      const { call } = await app.connect(moderator);
      expect(await call.userService.profile(renamed)).toEqual(renamed);
      expect(await call.userService.card({ id: victim.id })).toEqual({ ok: true, user: renamed });
      const response = await fetch(`${app.url}/qd/userService/profile`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer mod" },
        body: JSON.stringify(renamed),
      });
      expect(await response.json()).toEqual({ ok: true, d: renamed });
      // The schema that names the key sends it: what the warning is for.
      expect(await call.userService.lookup({ id: victim.id })).toMatchObject({
        user: { email: "victim@secret.example" },
      });
    } finally {
      await app.close();
    }
  });

  it("checks the replies of an output without JSON Schema, which cannot be reduced", async () => {
    const logger = captureLogger();
    const app = await createTestApp({ services: [defineUserService()], db: h.db, logger });
    const reader = { userId: victim.id };
    try {
      // The victim reads their own row: the reply carries "email", Admin-only, to a Read caller.
      expect(await app.as(reader).userService.legacy({ id: victim.id })).toMatchObject({
        email: "victim@secret.example",
      });
      await app.as(reader).userService.legacy({ id: victim.id });
      const warned = logger
        .at("warn")
        .map((entry) => entry.message)
        .filter((message) => message.includes("userService.legacy"));
      expect(warned).toEqual([
        expect.stringContaining(
          '[quickdraw:tiered-field-in-output] userService.legacy: its reply carries "email"',
        ),
      ]);
      expect(warned[0]).toContain("its output schema has no JSON Schema (a Zod 3 schema)");
    } finally {
      await app.close();
    }
  });
});
