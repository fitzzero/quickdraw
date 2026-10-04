import { defineConfig } from "tsup";

// The package ships one command, `quickdraw-codemod` (`bin/cli.mjs` loads
// `dist/cli.js`), and no library entry. ts-morph, the only dependency, stays
// external.
export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node24",
  sourcemap: true,
  clean: true,
});
