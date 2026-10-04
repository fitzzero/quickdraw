// The cluster projects' setup file: every `createTestApp` of the tests they
// run boots two servers behind Valkey (`nodes.ts`), the reader node every
// client connects to and the writer node every in-process write goes
// through. The tests themselves are the single-server ones; the few
// assertions a cluster answers differently by design ask `inCluster()`.

import { vi } from "vitest";

vi.mock("../../src/testing/createTestApp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/testing/createTestApp")>();
  const { clusterTestApp } = await import("./nodes");
  return {
    ...actual,
    createTestApp: (options: Parameters<typeof actual.createTestApp>[0]) =>
      clusterTestApp(actual.createTestApp, options),
  };
});
