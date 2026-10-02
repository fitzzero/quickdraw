import { defineConfig } from "tsup";

// Builds only the 5.0 sources in `src/`. `legacy-src/` (the 4.1 tree kept as a
// porting reference) is never an entry and is never imported from `src/`.
export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
});
