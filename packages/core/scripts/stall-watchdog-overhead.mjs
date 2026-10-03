// What the event-loop stall watchdog (`createServer({ stallWatchdog })`)
// costs an idle process. Run it after `bun run build`:
//
//   node packages/core/scripts/stall-watchdog-overhead.mjs [seconds] [rounds]
//
// Each round starts two fresh child processes, one with the watchdog off and
// one with it on, each creating the built server with no services and then
// doing nothing; after a second to settle, each measures its own CPU time
// (`process.cpuUsage()`, user plus system) over `seconds` (default 10). The
// watchdog's cost is the difference, as a share of one CPU over the window;
// the bar is 1%. A watchdog sampling far more often would show here first.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SETTLE_MS = 1_000;
const BAR_PERCENT = 1;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const silent = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
};

async function child(mode, seconds) {
  const { createServer } = await import("@fitzzero/quickdraw-core/server");
  const server = createServer({
    services: [],
    http: false,
    logger: silent,
    stallWatchdog: mode === "on",
  });
  await sleep(SETTLE_MS);
  const before = process.cpuUsage();
  await sleep(seconds * 1_000);
  const used = process.cpuUsage(before);
  await server.close();
  process.stdout.write(`${JSON.stringify({ mode, cpuMs: (used.user + used.system) / 1_000 })}\n`);
}

function run(mode, seconds) {
  const script = fileURLToPath(import.meta.url);
  const result = spawnSync(process.execPath, [script, "--child", mode, String(seconds)], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`the ${mode} child failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim().split("\n").at(-1)).cpuMs;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

async function main() {
  const [flag, mode, childSeconds] = process.argv.slice(2);
  if (flag === "--child") {
    await child(mode, Number(childSeconds));
    return;
  }
  const seconds = Number(process.argv[2] ?? 10);
  const rounds = Number(process.argv[3] ?? 3);
  const results = [];
  for (let index = 0; index < rounds; index += 1) {
    const off = run("off", seconds);
    const on = run("on", seconds);
    const percent = ((on - off) / (seconds * 1_000)) * 100;
    results.push(percent);
    console.log(
      `round ${index + 1}: off ${round(off)} ms CPU, on ${round(on)} ms CPU over ${seconds} s idle: +${round(on - off)} ms, ${round(percent)}% of one CPU`,
    );
  }
  const worst = Math.max(...results);
  console.log(
    `${worst < BAR_PERCENT ? "ok" : "over"} the watchdog adds at most ${round(worst)}% of one CPU to an idle process (bar: ${BAR_PERCENT}%)`,
  );
  if (worst >= BAR_PERCENT) {
    process.exitCode = 1;
  }
}

await main();
