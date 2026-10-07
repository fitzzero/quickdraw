// The `resolver-without-reads` development warning (finding R1.1 of the
// 5.0.0 review): raised once per service when a dispatcher is made, for a
// resolver without `reads`, alone or in `anyOf`; never for `reads: "none"`
// or declared reads.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defineContract } from "../../index";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { captureLogger } from "../__tests__/fixtures";
import type { PrismaClient } from "../../../test/prisma/setup";
import { anyOf, members, owner, resolver, type PolicyFor } from "../index";
import { qd } from "./__tests__/board";
import { resolverReadsWarnings } from "./resolverReads";

const levelsFor = () => ({});
const membership = {
  model: "projectMember",
  entry: "projectId",
  user: "userId",
  level: "role",
} as const;

function projectsBy(name: string, access: PolicyFor<PrismaClient, "project">) {
  return qd.defineService(defineContract(name, { methods: {} }), {
    model: "project",
    access,
    methods: {},
  });
}

const bare = projectsBy("bare", resolver({ levelsFor }));
const combined = projectsBy("combined", anyOf(owner("ownerId"), resolver({ levelsFor })));
const nested = projectsBy(
  "nested",
  anyOf(members(membership), anyOf(owner("ownerId"), resolver({ levelsFor }))),
);
const none = projectsBy("none", anyOf(owner("ownerId"), resolver({ levelsFor, reads: "none" })));
const declared = projectsBy(
  "declared",
  resolver({ levelsFor, reads: { columns: ["ownerId"], memberships: [membership] } }),
);
const declarative = projectsBy("declarative", anyOf(owner("ownerId"), members(membership)));

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 60_000);

afterAll(async () => {
  await h.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolverReadsWarnings", () => {
  it("warns about a resolver without reads, alone or in anyOf at any depth", () => {
    expect(resolverReadsWarnings(bare)).toEqual([
      {
        kind: "resolver-without-reads",
        service: "bare",
        message: expect.stringContaining(
          "bare: its access policy uses a resolver that declares no reads",
        ) as unknown,
        meta: { model: "project" },
      },
    ]);
    expect(resolverReadsWarnings(combined)).toHaveLength(1);
    expect(resolverReadsWarnings(nested)).toHaveLength(1);
    const [warning] = resolverReadsWarnings(bare);
    expect(warning?.message).toContain('reads: "none"');
    expect(warning?.message).toContain("columns of the project model");
  });

  it('leaves alone a resolver with reads or reads: "none", and the declarative policies', () => {
    for (const service of [none, declared, declarative]) {
      expect(resolverReadsWarnings(service), service.name).toEqual([]);
    }
  });
});

describe("when a dispatcher is made", () => {
  it("logs each service's warning once, in development only", () => {
    const logger = captureLogger();
    qd.createDispatcher({ services: [bare, combined, none, declared], db: h.db, logger });
    expect(logger.at("warn").map((entry) => entry.message)).toEqual([
      expect.stringMatching(/^\[quickdraw:resolver-without-reads\] bare: /),
      expect.stringMatching(/^\[quickdraw:resolver-without-reads\] combined: /),
    ]);
    vi.stubEnv("NODE_ENV", "production");
    const quiet = captureLogger();
    qd.createDispatcher({ services: [bare], db: h.db, logger: quiet });
    expect(quiet.at("warn")).toEqual([]);
  });
});
