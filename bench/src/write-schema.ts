import { writeFile } from "node:fs/promises";
import { SCHEMA_FILE } from "./paths";
import { resultJsonSchema } from "./result-schema";

/** Regenerate bench/result.schema.json from the zod schema (`bun run --filter bench schema`). */
await writeFile(SCHEMA_FILE, `${JSON.stringify(resultJsonSchema(), null, 2)}\n`);
process.stdout.write(`wrote ${SCHEMA_FILE}\n`);
