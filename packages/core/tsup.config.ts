import { defineConfig } from "tsup";

// Builds only the 5.0 sources in `src/`. `legacy-src/` (the 4.1 tree kept as a
// porting reference) is never an entry and is never imported from `src/`.
//
// One entry per export in package.json. `splitting` puts code that several
// entries import into shared chunks, so each export does not carry its own
// copy. Every dependency and peer dependency in package.json stays external.
// esbuild keeps an entry point's directives, so the `"use client"` that opens
// `src/client/index.ts` also opens `dist/client/index.js`; `tsup`'s rollup
// `treeshake` pass would strip it, so it stays off. The directive of any other
// module is dropped when it is bundled, which is why `./utils` (no directive)
// may share chunks with `./client`. `scripts/dist-smoke.mjs` checks the built
// output.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "server/index": "src/server/index.ts",
    "server/auth/index": "src/server/auth/index.ts",
    "server/express/index": "src/server/express/index.ts",
    "server/mcp/index": "src/server/mcp/index.ts",
    "client/index": "src/client/index.ts",
    "utils/index": "src/utils/index.ts",
    parser: "src/protocol/parser.ts",
    "prisma/index": "src/prisma/index.ts",
    "testing/index": "src/testing/index.ts",
    "testing/prisma": "src/testing/prisma.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
});
