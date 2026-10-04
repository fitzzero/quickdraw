// The appendix of MIGRATION.md (repository root): every 4.x name 5.0 removed
// or moved, with what replaces it, generated from @fitzzero/quickdraw-lint's
// no-v4-api rule (packages/lint/plugin/rules/no-v4-api.mjs), whose messages
// are the replacements. `bun run guide:sync` (in packages/codemod) rewrites
// the section between its markers; test/guide.test.ts checks it.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MOVED_NAMES,
  REMOVED_ENTRIES,
  REMOVED_MEMBERS,
  REMOVED_NAMES,
  REMOVED_OPTIONS,
  REMOVED_PROVIDER_PROPS,
} from "../../lint/plugin/rules/no-v4-api.mjs";

export const GUIDE = fileURLToPath(new URL("../../../MIGRATION.md", import.meta.url));
export const START = "<!-- removed-names:start -->";
export const END = "<!-- removed-names:end -->";

function cell(text) {
  return text.replaceAll("|", "\\|");
}

function table(heading, label, entries) {
  return [
    `### ${heading}`,
    "",
    `| ${label} | In 5.0 |`,
    "| --- | --- |",
    ...entries.map(([name, replacement]) => `| ${cell(name)} | ${cell(replacement)} |`),
    "",
  ];
}

/** The generated section, between its markers. */
export function namesSection() {
  const moved = Object.entries(MOVED_NAMES).flatMap(([entry, names]) =>
    Object.entries(names).map(([name, replacement]) => [
      `\`${name}\` from \`${entry}\``,
      replacement,
    ]),
  );
  const code = (entries) =>
    Object.entries(entries).map(([name, replacement]) => [`\`${name}\``, replacement]);
  return [
    START,
    "",
    "Generated from `@fitzzero/quickdraw-lint`'s `no-v4-api` rule, which reports each of these with the same text.",
    "",
    ...table("Names no 5.0 entry point exports", "4.x name", code(REMOVED_NAMES)),
    ...table("Names that moved", "4.x import", moved),
    ...table("Entry points", "4.x entry point", code(REMOVED_ENTRIES)),
    ...table(
      "Service methods",
      "4.x method",
      code(REMOVED_MEMBERS).map(([name, text]) => [`${name.slice(0, -1)}()\``, text]),
    ),
    ...table("Option keys", "4.x option", code(REMOVED_OPTIONS)),
    ...table("QuickdrawProvider props", "4.x prop", code(REMOVED_PROVIDER_PROPS)),
    END,
  ].join("\n");
}

/** `text` with the section between the markers replaced by `namesSection()`. */
export function withNames(text) {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start === -1 || end === -1) {
    throw new Error(`MIGRATION.md has no ${START} ... ${END} section`);
  }
  return text.slice(0, start) + namesSection() + text.slice(end + END.length);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = readFileSync(GUIDE, "utf8");
  const synced = withNames(text);
  if (synced !== text) {
    writeFileSync(GUIDE, synced);
    process.stdout.write("guide:sync: rewrote the removed names of MIGRATION.md\n");
  }
}
