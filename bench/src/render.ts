import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { renderMarkdown } from "./report";
import { resultSchema } from "./result-schema";

/**
 * Re-render a result file's Markdown report without rerunning anything:
 * `bun run --filter bench report -- baselines/4.1.0.json reports/4.1.0.md`.
 */
const [jsonArg, markdownArg] = process.argv.slice(2).filter((arg) => arg !== "--");
if (jsonArg === undefined || markdownArg === undefined) {
  process.stderr.write("usage: bun run --filter bench report -- <result.json> <report.md>\n");
  process.exit(1);
}
const jsonPath = resolve(jsonArg);
const markdownPath = resolve(markdownArg);
const result = resultSchema.parse(JSON.parse(await readFile(jsonPath, "utf8")));
await writeFile(markdownPath, renderMarkdown(result, relative(dirname(markdownPath), jsonPath)));
process.stdout.write(`wrote ${markdownPath}\n`);
