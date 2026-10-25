// React and TanStack Query, refused for the whole process, as if they were
// not installed (RFC 0003 section 11): a module hook that refuses `react`,
// `react-dom` and every `@tanstack/` package, to `import` and `require`
// alike, by the name asked for and by the file it resolves to (vitest hands
// the dependencies it leaves to Node over by their file URL, and bun keeps
// each under node_modules/.bun/). `react-is` stays: it is not React, and
// vitest's own formatting (pretty-format) loads it.
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
