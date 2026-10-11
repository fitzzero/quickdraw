// How much memory the codemod needs on a large app. Generates a quickdraw 4.1
// app in .test-output/scale (35 services of 20 methods each, in the class,
// method-module and port shapes, and 1,500 api and 1,500 web filler files
// that use zod and react-query), runs the built command (`bun run build`
// first) on it with --dry-run, and prints the run's peak resident memory
// (maxRSS), then the smallest heap it completes in, found by halving.
//
//   node scripts/scale.mjs [--services 35] [--methods 20] [--api 1500] [--web 1500]
//                          [--max 8192] [--step 256] [--no-search] [--bin <bin/cli.mjs>]
//
// --bin runs another build of the command, such as one of the base branch.
//
// A release and design tool, like bench/: CI never runs it.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { generateApp } from "./scale-app.mjs";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const APP = join(PACKAGE, ".test-output/scale");

const { values } = parseArgs({
  options: {
    services: { type: "string", default: "35" },
    methods: { type: "string", default: "20" },
    api: { type: "string", default: "1500" },
    web: { type: "string", default: "1500" },
    max: { type: "string", default: "8192" },
    step: { type: "string", default: "256" },
    "no-search": { type: "boolean", default: false },
    bin: { type: "string" },
  },
});
const SERVICES = Number(values.services);
const BIN = resolve(values.bin ?? join(PACKAGE, "bin/cli.mjs"));

function say(line) {
  process.stdout.write(`${line}\n`);
}

const PRELOAD = `data:text/javascript,${encodeURIComponent(
  `process.on("exit", () => process.stderr.write("\\nscale: " + JSON.stringify({ maxRSS: process.resourceUsage().maxRSS }) + "\\n"));`,
)}`;

/** One dry run at a heap of `heap` MiB: whether it completed, its peak RSS (MiB) and its time. */
function run(heap) {
  const env = { ...process.env, QUICKDRAW_CODEMOD_RELAUNCHED: "1" };
  delete env.NODE_OPTIONS;
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    [`--max-old-space-size=${String(heap)}`, `--import=${PRELOAD}`, BIN, "v5", APP, "--dry-run"],
    { env, encoding: "utf8", maxBuffer: 1024 ** 3 },
  );
  const seconds = (Date.now() - started) / 1000;
  const reported = /scale: (\{.*\})/u.exec(result.stderr)?.[1];
  const maxRSS =
    reported === undefined ? undefined : Math.round(JSON.parse(reported).maxRSS / 1024);
  const ok = result.status === 0;
  const summary = ok
    ? (result.stdout.split("\n")[1] ?? "").trim()
    : (result.stderr.match(/heap out of memory|[^\n]+$/u)?.[0] ?? "");
  say(
    `heap ${String(heap).padStart(5)} MiB: ${ok ? "completed" : `failed (${String(result.status ?? result.signal)})`} in ${seconds.toFixed(0)} s, maxRSS ${maxRSS === undefined ? "?" : String(maxRSS)} MiB${summary === "" ? "" : `: ${summary}`}`,
  );
  return { ok, maxRSS };
}

if (!existsSync(join(dirname(BIN), "../dist/cli.js"))) {
  process.stderr.write("scale: build the codemod first (bun run build)\n");
  process.exit(1);
}
generateApp({
  app: APP,
  services: SERVICES,
  methods: Number(values.methods),
  api: Number(values.api),
  web: Number(values.web),
});
say(
  `scale: ${String(SERVICES)} services x ${values.methods} methods, ${values.api} api and ${values.web} web filler files in ${APP}`,
);
const max = Number(values.max);
const first = run(max);
if (!first.ok) {
  say(`scale: the run does not complete in ${String(max)} MiB; pass a larger --max`);
  process.exit(1);
}
if (values["no-search"] !== true) {
  const step = Number(values.step);
  let low = 0;
  let high = max;
  while (high - low > step) {
    const middle = Math.min(
      high - step,
      Math.max(low + step, Math.round((low + high) / 2 / step) * step),
    );
    if (run(middle).ok) {
      high = middle;
    } else {
      low = middle;
    }
  }
  say(`scale: the smallest heap that completes is ${String(high)} MiB (to ${String(step)} MiB)`);
}
