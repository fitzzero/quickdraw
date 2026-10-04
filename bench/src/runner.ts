import { parseOptions, USAGE } from "./cli";
import { log } from "./log";
import { orchestrate } from "./orchestrate";

/** Entry point: `bun run --filter bench bench -- [options]` (see USAGE in cli.ts). */
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  try {
    await orchestrate(parseOptions(argv));
    return 0;
  } catch (error) {
    log(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return 1;
  }
}

// Exit explicitly: per-client cap timers may still be pending after the last run.
process.exit(await main());
