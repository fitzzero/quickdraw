// End to end (RFC 0003 section 4.4, finding R1.1 of the 5.0.0 review): a
// `resolver` policy is re-checked when access is revoked, as `members` is,
// once it declares what it reads. Three services over the same projects give
// a member the same level from the same membership table: `members(...)`,
// `resolver({ ..., reads })` and a `resolver` that declares nothing. When the
// member's row is deleted through the tracked client, the first two revoke the
// member's live row before the project is renamed; the third cannot know the
// deletion concerns it and keeps sending the row, which is what the
// `resolver-without-reads` warning is about.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { captureLogger } from "../../src/prisma/__tests__/harness";
import { defineContract } from "../../src/index";
import { qd, receive, sub } from "../../src/server/emit/__tests__/live";
import {
  members,
  resolver,
  type PolicyFor,
  type PolicyTools,
  type Principal,
} from "../../src/server/index";
import { DevWarningError } from "../../src/testing/index";
import type { PrismaClient } from "../prisma/setup";
import { as, e2eApp } from "../fixtures/app";

const e2e = e2eApp();

const membership = {
  model: "projectMember",
  entry: "projectId",
  user: "userId",
  level: "role",
} as const;

/** The member's level from the membership table, as `members(membership)` reads it. */
const memberLevels = (principal: Principal, ids: readonly string[], tools: PolicyTools) =>
  tools.memberships({ ...membership, levels: undefined }, principal.userId, ids);

function projectsBy(name: string, access: PolicyFor<PrismaClient, "project">) {
  const contract = defineContract(name, {
    entity: z.object({ id: z.string(), name: z.string() }),
    methods: {},
  });
  return qd.defineService(contract, { model: "project", access, methods: {} });
}

const memberProjects = projectsBy("memberProjects", members(membership));
const resolvedProjects = projectsBy(
  "resolvedProjects",
  resolver({ levelsFor: memberLevels, reads: { memberships: [membership] } }),
);
const undeclaredProjects = projectsBy("undeclaredProjects", resolver({ levelsFor: memberLevels }));

const SERVICES = ["memberProjects", "resolvedProjects", "undeclaredProjects"] as const;

/** A `qd:sub` acknowledgement that sent P1's row: the subscriber may read it. */
const SUBSCRIBED = { ok: true, r: [{ ok: true, d: { name: "P1" } }] };

describe("a resolver policy that declares its reads", () => {
  it("revokes a removed member's live row as members() does; one that declares nothing keeps sending it", async () => {
    const logger = captureLogger();
    const { app, write } = await e2e.start({
      services: [memberProjects, resolvedProjects, undeclaredProjects],
      logger,
    });
    const board = e2e.board();
    // One socket per service for the removed member, cy; bo stays a member throughout.
    const removed = new Map<string, ReturnType<typeof receive>>();
    for (const service of SERVICES) {
      const connection = await app.connect(as(board.cy));
      removed.set(service, receive(connection));
      expect(await sub(connection, service, [board.p1])).toMatchObject(SUBSCRIBED);
    }
    const stays = await app.connect(as(board.bo));
    const kept = receive(stays);
    expect(await sub(stays, "resolvedProjects", [board.p1])).toMatchObject(SUBSCRIBED);

    await write((db) =>
      db.projectMember.deleteMany({ where: { projectId: board.p1, userId: board.cy } }),
    );
    await write((db) => db.project.update({ where: { id: board.p1 }, data: { name: "Renamed" } }));
    await Promise.all([...removed.values(), kept].map(async (frames) => await frames.settle()));

    const renamed = expect.objectContaining({ name: "Renamed" }) as unknown;
    for (const service of ["memberProjects", "resolvedProjects"]) {
      const frames = removed.get(service);
      expect(frames?.revoked, service).toEqual([
        { kind: "entity", reason: "access", s: service, id: board.p1 },
      ]);
      expect(frames?.entity, service).toEqual([]);
    }
    // The member who stays gets the rename.
    expect(kept.revoked).toEqual([]);
    expect(kept.entity).toEqual([
      expect.objectContaining({ s: "resolvedProjects", id: board.p1, d: renamed }),
    ]);
    // Without reads the deletion concerns no subscription, and the rename reaches cy.
    const undeclared = removed.get("undeclaredProjects");
    expect(undeclared?.revoked).toEqual([]);
    expect(undeclared?.entity).toEqual([
      expect.objectContaining({ s: "undeclaredProjects", id: board.p1, d: renamed }),
    ]);

    const warned = logger.warnings.filter((message) => message.includes("resolver-without-reads"));
    expect(warned).toEqual([
      expect.stringContaining("[quickdraw:resolver-without-reads] undeclaredProjects"),
    ]);
  });

  it("fails to start a test app made with strictWarnings while a resolver declares nothing", async () => {
    await expect(
      e2e.start({ services: [undeclaredProjects], strictWarnings: true }),
    ).rejects.toThrow(DevWarningError);
    await expect(
      e2e.start({ services: [resolvedProjects], strictWarnings: true }),
    ).resolves.toBeDefined();
  });
});
