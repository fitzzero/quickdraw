// Smoke test for the built package. Run it after `bun run build`:
//
//   node packages/core/scripts/dist-smoke.mjs
//
// It imports every export in package.json through the package's own name, so
// Node resolves each one through the export map exactly as a consumer would,
// and then checks the output shape:
//
// - each export provides a known symbol;
// - `./client` opens with the "use client" directive and no other export does;
// - every source module is emitted into exactly one output file (entries share
//   chunks; with `splitting` off each entry would carry its own copy);
// - no dependency is bundled (every source path is the package's own);
// - the Redis helper's dynamic imports of its optional peers resolve from the
//   built output (both are devDependencies, so they are installed here).

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(packageDir, "dist");
const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));

/** One symbol each export must provide, and whether the export is client code. */
const expectations = {
  ".": { symbol: "QUICKDRAW_VERSION", client: false },
  "./server": { symbol: "createRateLimiter", client: false },
  "./server/auth": { symbol: "createJWT", client: false },
  "./server/express": { symbol: "createJsonRateLimiter", client: false },
  "./client": { symbol: "formatCurrency", client: true },
  "./testing/prisma": { symbol: "createPrismaTestGlobalSetup", client: false },
};

const USE_CLIENT = /^(["'])use client\1;?/;

const exportPaths = Object.keys(pkg.exports).filter((path) => path !== "./package.json");
assert.deepEqual(
  [...exportPaths].sort(),
  Object.keys(expectations).sort(),
  "every export in package.json needs an entry in this script's expectations",
);

for (const exportPath of exportPaths) {
  const target = pkg.exports[exportPath];
  const { symbol, client } = expectations[exportPath];

  for (const file of [target.types, target.import]) {
    assert.ok(existsSync(join(packageDir, file)), `${exportPath}: ${file} is missing`);
  }

  const specifier = exportPath === "." ? pkg.name : `${pkg.name}${exportPath.slice(1)}`;
  const module = await import(specifier);
  assert.notEqual(module[symbol], undefined, `${specifier} does not export ${symbol}`);

  const code = readFileSync(join(packageDir, target.import), "utf8");
  assert.equal(
    USE_CLIENT.test(code),
    client,
    `${target.import} ${client ? "must" : "must not"} begin with "use client"`,
  );

  console.log(`ok ${specifier} exports ${symbol}${client ? ' and begins with "use client"' : ""}`);
}

const sourceMaps = readdirSync(distDir, { recursive: true })
  .map(String)
  .filter((file) => file.endsWith(".js.map"));
assert.ok(sourceMaps.length > 0, "dist has no source maps; the build must emit them");

const emittedIn = new Map();
for (const mapFile of sourceMaps) {
  const { sources } = JSON.parse(readFileSync(join(distDir, mapFile), "utf8"));
  for (const source of sources) {
    const sourcePath = relative(packageDir, resolve(distDir, dirname(mapFile), source));
    emittedIn.set(sourcePath, [...(emittedIn.get(sourcePath) ?? []), mapFile.slice(0, -4)]);
  }
}

const bundled = [...emittedIn.keys()].filter((source) => !source.startsWith("src/"));
assert.deepEqual(bundled, [], "dependencies were bundled into dist instead of staying external");

const duplicated = [...emittedIn].filter(([, outputs]) => outputs.length > 1);
assert.deepEqual(duplicated, [], "source modules were emitted more than once; is splitting off?");
console.log(`ok ${emittedIn.size} source modules, each emitted once, no bundled dependencies`);

const { isRedisAdapterAvailable } = await import(`${pkg.name}/server`);
assert.equal(await isRedisAdapterAvailable(), true, "the Redis helper could not import its peers");
console.log("ok the Redis helper imports redis and @socket.io/redis-adapter");
