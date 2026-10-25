// React and TanStack Query, refused for the whole process, as if they were
// not installed (RFC 0003 section 11): a module hook that refuses `react`,
// `react-dom` and every `@tanstack/` package, to `import` and `require`
// alike, by the name asked for and by the file it resolves to. Vitest
// imports the dependencies it leaves to Node by their path, so for those
// the name never reaches the hook, and React's own files import each other
// by relative path: without the file check, an `import "react"` in a module
// a test loads would go through. bun keeps each package under
// node_modules/.bun/, which the file check allows for. `react-is` (and any
// other `react-` package) is not refused: it holds no React, and the value
// formatters that tell React elements apart load it (the pretty-format
// Testing Library ships).
//
// Loaded before anything else: with `node --import` by the `client-core`
// vitest project, in each of its workers (vitest.config.ts), and imported
// first by `client-core-smoke.mjs`. Nothing `./client/core` reaches may load
// either, at any time.

import { registerHooks } from "node:module";

const REFUSED_NAME = /^(react|react-dom)(\/|$)|^@tanstack\//;
const REFUSED_FILE = /\/node_modules\/(react|react-dom|@tanstack)\//;

const refused = (what) =>
  new Error(`refused ${what}: this process runs without React and TanStack Query`);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (REFUSED_NAME.test(specifier)) {
      throw refused(specifier);
    }
    const resolved = nextResolve(specifier, context);
    if (REFUSED_FILE.test(resolved.url)) {
      throw refused(`${specifier} (${resolved.url})`);
    }
    return resolved;
  },
});
