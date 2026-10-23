// The React-free client entry where neither React nor TanStack Query can be
// loaded. dist-smoke.mjs runs it, in a process of its own, after
// `bun run build`; by hand:
//
//   node packages/core/scripts/client-core-smoke.mjs
//
// A module hook refuses `react`, `react-dom` and every `@tanstack/` package
// for the whole process, to `import` and `require` alike, as if they were not
// installed: `./client/core`, or anything it loads at any time, importing one
// of them fails this script. With the hook on, it serves a method with the
// built server (`./server`, which needs neither), then calls it through
// `./client/core`: over a v5 socket with `createQuickdrawConnection` and
// `callData`, and over HTTP with the `createServerCaller` it re-exports from
// `./utils`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REFUSED = /^(react|react-dom)(\/|$)|^@tanstack\//;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (REFUSED.test(specifier)) {
      throw new Error(`refused ${specifier}: this process runs without React and TanStack Query`);
    }
    return nextResolve(specifier, context);
  },
});

// The hook is on: both are installed here (./client's devDependencies).
await assert.rejects(import("react"), /refused react/);
await assert.rejects(import("@tanstack/react-query"), /refused @tanstack\/react-query/);

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const { name } = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const core = await import(`${name}/client/core`);
const root = await import(name);
const server = await import(`${name}/server`);

const text = {
  "~standard": {
    version: 1,
    vendor: "smoke",
    validate: (value) =>
      typeof value === "string" ? { value } : { issues: [{ message: "Expected a string" }] },
  },
};
const echo = root.defineContract("echoService", {
  methods: { say: root.query({ input: text, output: text }) },
});
const echoService = server.initQuickdraw().defineService(echo, {
  methods: { say: { access: "public", handler: ({ input }) => input.toUpperCase() } },
});
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };
const app = server.createServer({ services: [echoService], logger: quiet });
await new Promise((listening) => {
  app.httpServer.listen(0, "127.0.0.1", listening);
});
const url = `http://127.0.0.1:${app.httpServer.address().port}`;
try {
  const connection = core.createQuickdrawConnection({ url, transports: ["websocket"] });
  connection.open();
  try {
    assert.equal(
      await core.callData(connection, { service: "echoService", method: "say", input: "core" }),
      "CORE",
    );
  } finally {
    connection.close();
  }
  const caller = core.createServerCaller({ echo }, { url });
  assert.equal(await caller.echo.say.call("http"), "HTTP");
} finally {
  await app.close();
}
console.log(
  `ok ${name}/client/core calls a built server over a v5 socket and over HTTP, with React and TanStack Query refused`,
);
