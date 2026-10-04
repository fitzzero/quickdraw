// The README example app's setup file, run in each test worker before its
// tests: what jsdom lacks for components against a real server, and an
// empty database before each test (the worker's own, `@project/db`).

import { installJsdomShims } from "@fitzzero/quickdraw-core/testing/client";
import { resetDatabase } from "@fitzzero/quickdraw-core/testing/prisma";
import { prisma } from "@project/db";
import { beforeEach } from "vitest";

installJsdomShims();

beforeEach(async () => {
  await resetDatabase(prisma);
});
