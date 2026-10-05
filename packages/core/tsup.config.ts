import { defineConfig } from "tsup";

// One entry per export in package.json. `splitting` puts code that several
// entries import into shared chunks, so each export does not carry its own
// copy. Every dependency and peer dependency in package.json stays external.
// esbuild keeps an entry point's directives, so the `"use client"` that opens
// `src/client/index.ts` also opens `dist/client/index.js`; `tsup`'s rollup
// `treeshake` pass would strip it, so it stays off. The directive of any other
// module is dropped when it is bundled, which is why `./utils` (no directive)
// may share chunks with `./client`, and `./testing/client` and
// `./testing/mock` (test helpers, no directive) too: the mock's provider
// fills the very context `./client`'s hooks read, so they must share it.
// `scripts/dist-smoke.mjs` checks the built output.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "server/index": "src/server/index.ts",
    "server/auth/index": "src/server/auth/index.ts",
    "server/express/index": "src/server/express/index.ts",
    "server/mcp/index": "src/server/mcp/index.ts",
    "server/otel": "src/server/observability/otel.ts",
    "client/index": "src/client/index.ts",
    "utils/index": "src/utils/index.ts",
    parser: "src/protocol/parser.ts",
    "prisma/index": "src/prisma/index.ts",
    "testing/index": "src/testing/index.ts",
    "testing/prisma": "src/testing/prisma.ts",
    "testing/client": "src/testing/client.tsx",
    "testing/mock": "src/testing/mock.ts",
    // The `quickdraw-docs` bin (package.json `bin`), not an export.
    "cli/quickdraw-docs": "src/cli/quickdraw-docs.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
});
