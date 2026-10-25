// The React-free client entry where neither React nor TanStack Query can be
// loaded. dist-smoke.mjs runs it, in a process of its own, after
// `bun run build`; by hand:
//
//   node packages/core/scripts/client-core-smoke.mjs
//
// A module hook (`refuse-react.mjs`, imported first) refuses `react`,
// `react-dom` and every `@tanstack/` package for the whole process, to
// `import` and `require` alike, as if they were not installed: `./client/core`,
// or anything it loads at any time, importing one of them fails this script.
// With the hook on, it serves a method and a stream with the built server
// (`./server`, which needs neither), then reaches both through
// `./client/core`: the method over a v5 socket with `createQuickdrawConnection`
// and `callData`, and over HTTP with the `createServerCaller` it re-exports
// from `./utils`; the stream's seed through a live store (`liveStoreOf` and
// `holdStream`).

import "./refuse-react.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  streams: { news: { item: text, seed: 2, access: "public" } },
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
for (const item of ["first", "second", "third"]) {
  app.stream(echo, "news").push(item);
}
try {
  const connection = core.createQuickdrawConnection({ url, transports: ["websocket"] });
  const live = core.liveStoreOf(connection);
  connection.open();
  try {
    assert.equal(
      await core.callData(connection, { service: "echoService", method: "say", input: "core" }),
      "CORE",
    );
    const seed = await new Promise((resolve, reject) => {
      const news = core.holdStream(live, { contract: echo, stream: "news" }, (feed) => {
        if (feed.error !== null) {
          news.release();
          reject(feed.error);
        } else if (!feed.isLoading) {
          news.release();
          resolve(feed.items);
        }
      });
    });
    assert.deepEqual(seed, ["second", "third"]);
  } finally {
    connection.close();
  }
  const caller = core.createServerCaller({ echo }, { url });
  assert.equal(await caller.echo.say.call("http"), "HTTP");
} finally {
  await app.close();
}
console.log(
  `ok ${name}/client/core calls a built server over a v5 socket and over HTTP, and holds its stream in a live store, with React and TanStack Query refused`,
);
