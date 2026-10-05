import { fileURLToPath } from "node:url";
import { defineConfig, type TestProjectInlineConfiguration } from "vitest/config";

// Three projects: `.test.ts` runs under node, `.test.tsx` (React hooks and
// components) under jsdom, and `.test-d.ts` (type tests) is type-checked, never
// run. Tests are collected from `src/` and from `test/` (the end-to-end suite
// in `test/e2e/`, which renders the real client hooks against a real server
// in the test process; jsdom needs no setting for that: the server listens on
// a Node socket, and the client connects over jsdom's WebSocket).
//
// The README's example app (test/readme) is typechecked as a whole; its
// component tests (`test/readme/apps/web/**/*.test.tsx`, which hold the
// README's `renderWithQuickdraw` example) also run, in the `readme` project:
// under jsdom, with the app's own test setup (a PGlite template migrated
// once, a database per worker, the jsdom shims) and its imports resolved as
// test/readme/tsconfig.json maps them, `@project/db` to the app's test
// database. Its other tests (the services', with budgets) are typechecked only.
//
// With QD_CLUSTER=1 (`bun run test:cluster`), and only then, two more
// projects run instead: `cluster` (node) and `cluster-dom` (jsdom). They run
// the end-to-end suite and the realtime, collection and revocation tests
// with every test app booted as two servers behind a real Valkey
// (`test/cluster/setup.ts`), plus the cluster's own tests in
// `test/cluster/`. They need the Valkey of `test/cluster/docker-compose.yml`
// (QD_VALKEY_URL, default redis://127.0.0.1:6399), which their global setup
// checks first. `bun run test` never runs them.

/** The node tests the cluster projects run split across two nodes, besides the end-to-end suite. */
const CLUSTER_NODE_TESTS = [
  "src/server/realtime/*.test.ts",
  "src/server/collections/*.test.ts",
  "src/server/emit/revocation.test.ts",
];

function clusterProject(
  name: string,
  environment: "node" | "jsdom",
  include: string[],
): TestProjectInlineConfiguration {
  return {
    extends: true,
    test: {
      name,
      include,
      environment,
      globalSetup: ["test/cluster/globalSetup.ts"],
      setupFiles: ["test/cluster/setup.ts"],
      env: { QD_CLUSTER: "1" },
      // Every test app is two servers and four Valkey connections.
      testTimeout: 20_000,
      hookTimeout: 60_000,
    },
  };
}

/** A file of this package, as an absolute path. */
const local = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/** The README app's imports, as test/readme/tsconfig.json maps them, but its db package: its test database. */
const README_ALIASES = [
  ["@fitzzero/quickdraw-core", "./src/index.ts"],
  ["@fitzzero/quickdraw-core/client", "./src/client/index.ts"],
  ["@fitzzero/quickdraw-core/prisma", "./src/prisma/index.ts"],
  ["@fitzzero/quickdraw-core/server", "./src/server/index.ts"],
  ["@fitzzero/quickdraw-core/server/auth", "./src/server/auth/index.ts"],
  ["@fitzzero/quickdraw-core/server/express", "./src/server/express/index.ts"],
  ["@fitzzero/quickdraw-core/testing", "./src/testing/index.ts"],
  ["@fitzzero/quickdraw-core/testing/client", "./src/testing/client.tsx"],
  ["@fitzzero/quickdraw-core/testing/mock", "./src/testing/mock.ts"],
  ["@fitzzero/quickdraw-core/testing/prisma", "./src/testing/prisma.ts"],
  ["@fitzzero/quickdraw-core/utils", "./src/utils/index.ts"],
  ["@project/db", "./test/readme/packages/db/src/testing.ts"],
  ["@project/shared", "./test/readme/packages/shared/src/index.ts"],
].map(([name, path]) => ({
  find: new RegExp(`^${(name ?? "").replaceAll("/", "\\/")}$`),
  replacement: local(path ?? ""),
}));

/** The README app's sources: typechecked, and only its component tests run (the `readme` project). */
const README_APP = ["test/readme/apps/**", "test/readme/packages/**"];

const clusterProjects: TestProjectInlineConfiguration[] =
  process.env.QD_CLUSTER === "1"
    ? [
        clusterProject("cluster", "node", [
          ...CLUSTER_NODE_TESTS,
          "test/e2e/*.test.ts",
          "test/cluster/*.test.ts",
        ]),
        clusterProject("cluster-dom", "jsdom", ["test/e2e/*.test.tsx", "test/cluster/*.test.tsx"]),
      ]
    : [];

export default defineConfig({
  test: {
    // Kept from 4.1: @testing-library/react registers its automatic cleanup
    // only when `afterEach` is a global.
    globals: true,
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**"],
      exclude: ["**/*.test.ts", "**/*.test.tsx", "**/*.test-d.ts", "**/testing.ts"],
    },
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["src/**/*.test.ts", "test/**/*.test.ts"],
          // The cluster's own tests need Valkey: they run in the cluster projects only.
          exclude: ["test/cluster/**", ...README_APP],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          include: ["src/**/*.test.tsx", "test/**/*.test.tsx"],
          exclude: ["test/cluster/**", ...README_APP],
          environment: "jsdom",
        },
      },
      {
        extends: true,
        resolve: { alias: README_ALIASES },
        test: {
          name: "readme",
          include: ["test/readme/apps/web/**/*.test.tsx"],
          environment: "jsdom",
          globalSetup: ["test/readme/globalSetup.ts"],
          setupFiles: ["test/readme/workerSetup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "types",
          typecheck: {
            enabled: true,
            only: true,
            include: ["src/**/*.test-d.ts"],
            tsconfig: "./tsconfig.json",
          },
        },
      },
      ...clusterProjects,
    ],
  },
});
