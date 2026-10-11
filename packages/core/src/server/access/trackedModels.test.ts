// The startup check of the models access depends on (the 5.1 audit's
// DATA-3): a membership table keyed by a composite `@@id` and no `id` column
// is never tracked, so removing a member never revoked anything, silently.
// `createServer` now names such a model at start, as an error in every
// environment, and a test app made with `strictWarnings` fails to start.
// The test schema's `VerificationToken` is keyed `@@id([identifier, token])`.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineContract, query } from "../../index";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, type TestApp } from "../../testing/index";
import { captureLogger } from "../__tests__/fixtures";
import { projectService, qd } from "../emit/__tests__/live";
import { members } from "../index";
import { createRegistry } from "../registry";
import type { StorageAdapter } from "../storage";
import { checkTrackedModels } from "./trackedModels";

let h: Harness;
const apps: TestApp[] = [];

beforeAll(async () => {
  h = await createHarness();
}, 60_000);

afterAll(async () => {
  await h.close();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(apps.splice(0).map(async (app) => await app.close()));
});

const contract = defineContract("tokenProjectService", {
  entity: z.object({ id: z.string(), name: z.string() }),
  methods: { get: query({ input: z.object({ id: z.string() }), output: "entity" }) },
});

/** A service whose policy reads a membership table without an id column. */
const untrackedService = qd.defineService(contract, {
  model: "project",
  access: members({
    model: "verificationToken",
    entry: "identifier",
    user: "token",
    level: "token",
  }),
  methods: {
    get: {
      access: { entry: "Read" },
      handler: ({ input, db }) => db.project.findUniqueOrThrow({ where: { id: input.id } }),
    },
  },
});

const PREFIX = "[quickdraw:untracked-access-model]";

describe("createServer's check of the models access depends on", () => {
  it("logs an error naming a membership table without an id", async () => {
    const logger = captureLogger();
    apps.push((await createTestApp({ services: [untrackedService], db: h.db, logger })) as never);
    const errors = logger.at("error").map((entry) => entry.message);
    expect(errors.filter((message) => message.startsWith(PREFIX))).toHaveLength(1);
    expect(errors.find((message) => message.startsWith(PREFIX))).toContain("verificationToken");
  });

  it("fails a strict test app at start", async () => {
    await expect(
      createTestApp({ services: [untrackedService], db: h.db, strictWarnings: true }),
    ).rejects.toMatchObject({
      name: "DevWarningError",
      warning: { kind: "untracked-access-model", subject: "verificationToken" },
    });
  });

  it("logs in production too", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const logger = captureLogger();
    apps.push((await createTestApp({ services: [untrackedService], db: h.db, logger })) as never);
    expect(logger.at("error").some((entry) => entry.message.startsWith(PREFIX))).toBe(true);
  });

  it("says nothing of tables that have an id", async () => {
    const logger = captureLogger();
    apps.push(
      (await createTestApp({
        services: [projectService],
        db: h.db,
        logger,
        strictWarnings: true,
      })) as never,
    );
    expect(logger.at("error")).toEqual([]);
  });
});

describe("a probe that fails", () => {
  it("is logged as a warning and never fails the check, strict or not", async () => {
    const logger = captureLogger();
    const storage = {
      trackable: () => Promise.reject(new Error("the database is down")),
    } as unknown as StorageAdapter;
    const registry = createRegistry([untrackedService]);
    await expect(
      checkTrackedModels(registry, storage, { logger, strict: true }),
    ).resolves.toBeUndefined();
    expect(logger.at("warn").map((entry) => entry.message)).toContain(
      "createServer: could not check whether verificationToken is tracked",
    );
    expect(logger.at("error")).toEqual([]);
  });
});
