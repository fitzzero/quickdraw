// `quickdraw-migration-report.md`: every review marker in the code, with its
// file and line, grouped by what it asks for. It is read back from the
// markers, so it matches the files whenever it is written, and running the
// codemod again after some items are done lists only what remains. It is
// written in the form Markdown formatters (oxfmt, prettier) keep, its table
// padded, so formatting it changes nothing and a later run that finds the
// same markers writes the same bytes.

import type { RunContext } from "./context";
import { repoPath } from "./layout";
import { type Category, findMarkers, type FoundMarker, MARKER } from "./markers";

/** The report's file name, at the repository root. */
export const REPORT_FILE = "quickdraw-migration-report.md";

interface Section {
  readonly title: string;
  readonly categories: readonly Category[];
  readonly intro: string;
}

const SECTIONS: readonly Section[] = [
  {
    title: "Services",
    categories: ["service"],
    intro:
      "Each service is read from one class of the api package outside test code: the one `registerService` instantiates, else the one named after the service. Other classes of the same service name, and 4.x service classes in test code (`__tests__`, `testing`, `*.test.ts`, `*.spec.ts`), are not read, and are marked. A contract whose 4.x method map names methods the class read implements none of was written from the wrong class: check it before anything else.",
  },
  {
    title: "Contracts",
    categories: ["contract"],
    intro:
      "Each method's kind was chosen from its name (get, list, search, find and count read). Inputs and outputs without a 4.x schema are `todoSchema` placeholders, which validate nothing; lint's `no-todo-schema` reports each one.",
  },
  {
    title: "Access",
    categories: ["access"],
    intro:
      'The forms admit exactly the callers 4.x admitted, and `jsonAcl("acl")` the rows 4.x\'s `hasEntryACL` did, but for a user listed twice in a row\'s list (marked). "Read" without a row id was open to every signed-in user; decide whether that was meant. A method whose input has `id` under a form that checks no row ("public", say) carries `rowless: true` (marked): 5.0 refuses to define that shape on a service with an access policy without it, and it keeps the 4.x callers.',
  },
  {
    title: "Access overrides to turn into a policy",
    categories: ["access-override"],
    intro:
      "4.x decided row access in overridden methods; 5.0 decides it in the service's `access` policy, for every surface at once.",
  },
  {
    title: "toDto and protected fields to turn into projections and fields",
    categories: ["projection"],
    intro:
      "Subscribers receive the contract's projections, built from rows, with field levels from the contract's `fields`.",
  },
  {
    title: "Collections to declare in contracts",
    categories: ["collection"],
    intro:
      "A 4.x `defineCollection` becomes a contract collection (`scope`, `item`, `order`, and `index` plus `views` for boards) anchored in `defineService`.",
  },
  {
    title: "Hand emits to delete",
    categories: ["emit"],
    intro:
      "5.0 sends entity frames and collection deltas from tracked writes; room events become contract events.",
  },
  {
    title: "this.create, this.update and this.delete to write through db",
    categories: ["write"],
    intro:
      "The 4.x CRUD helpers also emitted and ran lifecycle hooks; `db.<model>` writes are tracked and throw on failure.",
  },
  {
    title: "Raw SQL writes to record with ctx.touch",
    categories: ["raw-sql"],
    intro:
      "Tracked writes cannot see raw SQL; `ctx.touch(model, ids)` records the rows it changed (lint: `no-raw-sql-write`).",
  },
  {
    title: "Lifecycle hooks",
    categories: ["lifecycle"],
    intro: "Hooks ran only inside the CRUD helpers; move their work into the methods that write.",
  },
  {
    title: "installAdminMethods to replace with the admin kit",
    categories: ["admin"],
    intro: "`admin.contract({ entity })` and `admin.handlers(contract, options)`.",
  },
  {
    title: "Methods a kit implements",
    categories: ["kit"],
    intro:
      "Methods of a kit method's shape (`get`, `list`, `create`, `getTask`, ...): the kit checks access on every row it touches, pages and stays live (lint: `prefer-kit`). Replace each with its kit, or keep it with a `// quickdraw: hand-written because <reason>` comment above it.",
  },
  {
    title: "Service instance state and the 4.x context",
    categories: ["this", "context", "channel"],
    intro:
      "A service is an object now: no constructor, no fields, no `this`; handlers read `ctx.principal`.",
  },
  {
    title: "Errors the caller no longer sees",
    categories: ["error"],
    intro:
      "4.x sent a thrown error's message to the caller; 5.0 answers any error that is not a `QuickdrawError` with `INTERNAL` and a generic message (the original is logged). Throw `new QuickdrawError(code, message)` with the code that fits (`NOT_FOUND`, `FORBIDDEN`, `CONFLICT`, `VALIDATION`, ...) wherever the caller should see the message.",
  },
  {
    title: "Client",
    categories: ["client"],
    intro:
      "Hook calls now go through the typed client (`qd.<service>.<member>`); these need a decision.",
  },
  {
    title: "Server wiring and other 4.x APIs",
    categories: ["server", "v4-api"],
    intro:
      "What lint's `no-v4-api` also reports, each with its replacement: the server set-up, room helpers, removed types.",
  },
  {
    title: "Carve-outs",
    categories: ["carve-out"],
    intro:
      "New files written from code inside a template carve-out (the lines between its `<name>:start` and `<name>:end` comments): a fork that strips the carve-out must delete them too, so list each wherever the carve-out's own files are listed. The lines they add to shared files sit between the carve-out's comments.",
  },
];

function markersOf(ctx: RunContext): FoundMarker[] {
  return ctx.project
    .getSourceFiles()
    .flatMap((file) => findMarkers(file.getFullText(), repoPath(ctx.layout, file.getFilePath())))
    .toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function sectionText(section: Section, items: readonly FoundMarker[]): string[] {
  return [
    `## ${section.title}`,
    "",
    section.intro,
    "",
    ...items.map((item) => `- [ ] \`${item.file}:${String(item.line)}\` ${item.message}`),
    "",
  ];
}

/**
 * A Markdown table as oxfmt and prettier format one: every cell padded to
 * its column's width, a right-aligned column (`align` "right") padded on
 * the left.
 */
export function markdownTable(
  rows: readonly (readonly string[])[],
  align: readonly ("left" | "right")[],
): string[] {
  const widths = align.map((_, column) =>
    Math.max(3, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const cell = (text: string, column: number): string =>
    align[column] === "right"
      ? text.padStart(widths[column] ?? 0)
      : text.padEnd(widths[column] ?? 0);
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((text, column) => cell(text, column)).join(" | ")} |`;
  const [header = [], ...body] = rows;
  const rule = widths.map((width, column) =>
    align[column] === "right" ? `${"-".repeat(width - 1)}:` : "-".repeat(width),
  );
  return [line(header), line(rule), ...body.map((row) => line(row))];
}

/** The report's Markdown, and how many items it lists. */
export function buildReport(ctx: RunContext): { text: string; count: number } {
  const markers = markersOf(ctx);
  const grouped = SECTIONS.map((section) => ({
    section,
    items: markers.filter((marker) => section.categories.includes(marker.category)),
  }));
  const files = new Set(markers.map((marker) => marker.file)).size;
  const lines = [
    "# quickdraw 5.0 migration report",
    "",
    `Written by \`@fitzzero/quickdraw-codemod\` from the \`// ${MARKER}\` markers in the code; running the codemod again rewrites it from the markers that remain. Work through the sections in order (contracts, access, emits, client), delete each marker once its item is done, and see the migration guide (\`MIGRATION.md\`, shipped in \`@fitzzero/quickdraw-codemod\`) for each kind of item. Then run lint (\`no-v4-api\` names every 4.x API left, \`no-todo-schema\` every placeholder) and the typecheck.`,
    "",
  ];
  if (markers.length === 0) {
    return { text: [...lines, "Nothing is left to review.", ""].join("\n"), count: 0 };
  }
  lines.push(
    `${String(markers.length)} items in ${String(files)} files.`,
    "",
    ...markdownTable(
      [
        ["Section", "Items"],
        ...grouped
          .filter(({ items }) => items.length > 0)
          .map(({ section, items }) => [section.title, String(items.length)]),
      ],
      ["left", "right"],
    ),
    "",
    ...grouped
      .filter(({ items }) => items.length > 0)
      .flatMap(({ section, items }) => sectionText(section, items)),
  );
  return { text: lines.join("\n"), count: markers.length };
}
