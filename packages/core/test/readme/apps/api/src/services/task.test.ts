// The README's testing examples. Only typechecked: vitest does not run the
// README's example app (vitest.config.ts excludes test/readme/apps).

import {
  createTestApp,
  describeAccessMatrix,
  expectBudget,
  snapshotAccessMatrix,
} from "@fitzzero/quickdraw-core/testing";
import { resetDatabase } from "@fitzzero/quickdraw-core/testing/prisma";
import { prisma } from "@project/db";
import { beforeEach, expect, it } from "vitest";
import { db } from "../db";
import type { AppPrincipal } from "../quickdraw";
import { projectService } from "./project";
import { taskService } from "./task";

const ada: AppPrincipal = { userId: "ada", kind: "user" }; // owns the project
const bo: AppPrincipal = { userId: "bo", kind: "user" }; // a member with Read
const ed: AppPrincipal = { userId: "ed", kind: "user" }; // a stranger
let projectId = "";
let taskId = "";

// Seed with the untracked client: nothing subscribes yet, and a tracked write
// outside any unit of work would flush on its own with an `ambient-write` warning.
async function seed(): Promise<{ readonly projectId: string; readonly taskId: string }> {
  for (const { userId } of [ada, bo, ed]) {
    await prisma.user.create({
      data: { id: userId, name: userId, email: `${userId}@example.com` },
    });
  }
  const project = await prisma.project.create({ data: { name: "Launch", ownerId: ada.userId } });
  await prisma.projectMember.create({
    data: { projectId: project.id, userId: bo.userId, role: "Read" },
  });
  const task = await prisma.task.create({
    data: { projectId: project.id, title: "Write the docs" },
  });
  return { projectId: project.id, taskId: task.id };
}

beforeEach(async () => {
  ({ projectId, taskId } = await seed());
});

// #region app
it("sends a rename to the other members' boards", async () => {
  const app = await createTestApp({
    services: [projectService, taskService],
    db,
    strictWarnings: true,
  });
  const { call } = await app.connect(bo); // a real protocol 5 socket
  await call.taskService.get({ id: taskId });
  await app.as(ada).taskService.rename({ id: taskId, title: "Ship it" }); // in process
  await app.frames.waitFor({ event: "qd:e", userId: bo.userId }); // the entity frame bo receives
  await app.close();
});
// #endregion

// #region matrix
it("lets the owner rename, members read, and nobody else in", async () => {
  const app = await createTestApp({ services: [projectService, taskService], db });
  await describeAccessMatrix(app, {
    service: taskService,
    principals: { owner: ada, member: bo, stranger: ed },
    cases: [
      { method: "get", input: { id: taskId }, allow: ["owner", "member"] }, // everyone else is denied
      {
        method: "rename",
        input: { id: taskId, title: "x" },
        expect: { owner: "allow", member: "FORBIDDEN" },
      },
    ],
  });
  await app.close();
});
// #endregion

// #region snapshot
it("pins who may call what, for every method, subscribe and scope", async () => {
  const app = await createTestApp({ services: [projectService, taskService], db });
  const report = await snapshotAccessMatrix(app, {
    principals: { owner: ada, member: bo, stranger: ed },
    reset: async () => {
      await resetDatabase(prisma); // at the start, and after each write access let through
      return await seed();
    },
    rows: (board) => ({ projectService: board.projectId, taskService: board.taskId }),
  });
  expect(report.inconclusive).toEqual([]); // every cell ran, with an input its schema accepts
  await app.close();
});
// #endregion

// #region budget
it("counts a board within its budget", async () => {
  const app = await createTestApp({ services: [projectService, taskService], db });
  const result = await expectBudget(() => app.as(ada).taskService.countOnBoard({ projectId }), {
    name: "count a board",
  });
  expect(result.measured.calls).toHaveLength(1); // what the step cost: calls, statements, bytes
  await app.close();
});
// #endregion
