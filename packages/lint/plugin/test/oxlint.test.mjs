// The plugin under the oxlint CLI itself, through the shipped configs: an app
// laid out like the quickdraw template extends `oxlint.base.jsonc` and
// `oxlint.template.jsonc`, and every rule must report its own example there
// (config loading, `jsPlugins`, option schemas and the rules' file scopes all
// take part). Then the core package's fixture apps, laid out as that app's
// service files, must pass every rule that judges service definitions, and
// `quickdraw-lint baseline` must let an app adopt the rules.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findOxlint, runOxlint } from "../../bin/baseline.mjs";
import plugin from "../index.mjs";

const LINT = fileURLToPath(new URL("../..", import.meta.url));
const CORE = path.join(LINT, "..", "core");
const OXLINT = findOxlint(LINT);
const BIN = path.join(LINT, "bin", "quickdraw-lint.mjs");

/** One example per rule, at a path of the template's layout. */
const EXAMPLES = {
  "no-untracked-write": [
    "apps/api/src/services/untracked.ts",
    `import { prisma } from "@project/db";\nexport const touch = (id) => prisma.task.update({ where: { id }, data: {} });\n`,
  ],
  "no-foreign-write": [
    "apps/api/src/services/foreign.ts",
    `export const s = qd.defineService(task, { model: "task", methods: { m: { access: "authenticated", handler: ({ db }) => db.taskLabel.create({ data: {} }) } } });\n`,
  ],
  "no-nested-write": [
    "apps/api/src/services/nested.ts",
    `export const m = ({ db }) => db.task.create({ data: { labels: { create: [] } } });\n`,
  ],
  "no-raw-sql-write": [
    "apps/api/src/jobs/raw.ts",
    'export const purge = () => db.$executeRaw`DELETE FROM "Task"`;\n',
  ],
  "no-manual-emit": [
    "apps/api/src/services/emit.ts",
    `export const f = (room) => io.to(room).emit("changed", 1);\n`,
  ],
  "no-inline-auth-guard": [
    "apps/api/src/services/guard.ts",
    `export const m = { access: "public", handler: ({ ctx }) => { if (!ctx.principal) throw new Error("no"); } };\n`,
  ],
  "no-unbounded-read": [
    "apps/api/src/services/unbounded.ts",
    `export const m = ({ db }) => db.task.findMany();\n`,
  ],
  "no-db-call-in-loop": [
    "apps/api/src/jobs/loop.ts",
    `export async function f(ids) { for (const id of ids) { await db.task.delete({ where: { id } }); } }\n`,
  ],
  "no-emit-in-loop": [
    "apps/api/src/jobs/emit-loop.ts",
    `export function f(id, lines) { for (const line of lines) { qd.stream(task, "logs").push(id, line); } }\n`,
  ],
  "no-load-then-filter": [
    "apps/api/src/services/filter.ts",
    `export const m = async ({ db }) => (await db.task.findMany({ take: 9 })).filter((t) => t.done);\n`,
  ],
  "no-prisma-in-routes": [
    "apps/api/src/routes/hooks.ts",
    `export const f = () => prisma.task.count();\n`,
  ],
  "no-cross-service-internal-imports": [
    "apps/api/src/services/task/index.ts",
    `import { helper } from "../project/helpers.js";\nexport { helper };\n`,
  ],
  "no-await-void-mutate": [
    "apps/web/src/components/Save.tsx",
    `export const Save = ({ m }) => <button onClick={async () => { await m.mutate(1); }} />;\n`,
  ],
  "no-untyped-client": [
    "apps/web/src/components/Untyped.tsx",
    `import { useQuery } from "@tanstack/react-query";\nexport const T = ({ id }) => useQuery({ queryKey: ["t", id], queryFn: () => qd.task.get.call({ id }) }).data;\n`,
  ],
  "no-manual-refetch": [
    "apps/web/src/components/Refetch.tsx",
    `export const useReset = (queryClient) => () => queryClient.invalidateQueries({ queryKey: ["qd", "taskService"] });\n`,
  ],
  "no-raw-socket": [
    "apps/web/src/components/Socket.tsx",
    `export const send = () => socket.emit("taskService:get", {});\n`,
  ],
  "no-v4-api": [
    "apps/web/src/legacy.ts",
    `import { useSubscription } from "@fitzzero/quickdraw-core/client";\n`,
  ],
  "no-raw-button-strings": [
    "apps/web/src/components/Button.tsx",
    `export const B = () => <Button>Save</Button>;\n`,
  ],
  "no-raw-tooltip-strings": [
    "apps/web/src/components/Tooltip.tsx",
    `export const T = () => <Tooltip title="Archive"><span /></Tooltip>;\n`,
  ],
  "no-raw-typography-strings": [
    "apps/web/src/components/Typography.tsx",
    `export const T = () => <Typography>Empty</Typography>;\n`,
  ],
};

/** The rules that judge service definitions: the fixture apps' services must pass them. */
const SERVICE_DEFINITION_RULES = [
  "no-foreign-write",
  "no-nested-write",
  "no-raw-sql-write",
  "no-inline-auth-guard",
  "no-unbounded-read",
  "no-load-then-filter",
  "no-emit-in-loop",
  "no-v4-api",
];

function writeFiles(root, files) {
  for (const [file, code] of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), code);
  }
}

/**
 * A temporary app extending the shipped configs, with `settings` of its own
 * and oxlint installed (linked to this package's).
 */
function createApp(settings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quickdraw-lint-app-"));
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.symlinkSync(
    path.dirname(path.dirname(OXLINT)),
    path.join(root, "node_modules", "oxlint"),
    "dir",
  );
  const config = {
    extends: [
      path.relative(root, path.join(LINT, "oxlint.base.jsonc")),
      path.relative(root, path.join(LINT, "oxlint.template.jsonc")),
    ],
    plugins: ["typescript", "import", "react", "nextjs", "jsx_a11y"],
    ignorePatterns: ["**/node_modules/**"],
    ...(settings === undefined ? {} : { settings }),
  };
  fs.writeFileSync(path.join(root, ".oxlintrc.json"), JSON.stringify(config));
  return root;
}

/** The quickdraw diagnostics oxlint reports in `root`, as `{ rule, file, line }`. */
function lint(root) {
  const report = runOxlint({ cwd: root, paths: ["."], oxlint: OXLINT, ignoreBaselines: false });
  return report.diagnostics
    .filter((diagnostic) => diagnostic.code.startsWith("quickdraw("))
    .map((diagnostic) => ({
      rule: diagnostic.code.slice("quickdraw(".length, -1),
      file: diagnostic.filename.split(path.sep).join("/"),
      line: diagnostic.labels[0]?.span.line,
    }));
}

const roots = [];
afterAll(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("the oxlint CLI with the shipped configs", () => {
  let reports = [];
  beforeAll(() => {
    const root = createApp();
    roots.push(root);
    writeFiles(root, Object.values(EXAMPLES));
    reports = lint(root);
  });

  it("has an example for every rule of the plugin", () => {
    expect(Object.keys(EXAMPLES).toSorted()).toEqual(Object.keys(plugin.rules).toSorted());
  });

  it.each(Object.entries(EXAMPLES))("runs %s and reports its example", (rule, [file]) => {
    expect(reports).toContainEqual(expect.objectContaining({ rule, file }));
  });

  it("reports nothing else", () => {
    const expected = new Set(Object.entries(EXAMPLES).map(([rule, [file]]) => `${rule} ${file}`));
    const unexpected = reports.filter(({ rule, file }) => !expected.has(`${rule} ${file}`));
    // The route example's `prisma.task.count()` is also an untracked client in a route: not a write.
    expect(unexpected).toEqual([]);
  });
});

describe("the core package's fixture apps as service files", () => {
  const sources = [
    "test/fixtures/app.ts",
    "src/server/emit/__tests__/live.ts",
    "src/server/access/__tests__/board.ts",
    ...["admin", "crud", "search", "sharing"].map(
      (kit) => `src/server/kits/${kit}/__tests__/fixture.ts`,
    ),
    "src/server/collections/__tests__/fixture.ts",
    "src/server/realtime/__tests__/fixture.ts",
  ];

  it.each(SERVICE_DEFINITION_RULES)("pass %s", (rule) => {
    const root = createApp();
    roots.push(root);
    writeFiles(
      root,
      sources.map((source) => [
        `apps/api/src/services/${source.replaceAll("/", "-")}`,
        fs.readFileSync(path.join(CORE, source), "utf8"),
      ]),
    );
    expect(lint(root).filter((report) => report.rule === rule)).toEqual([]);
  });
});

describe("quickdraw-lint baseline", () => {
  it("lets an app adopt the rules, then reports only new violations", () => {
    const root = createApp({ quickdraw: { baseline: ".quickdraw-lint-baseline.json" } });
    roots.push(root);
    const service = "apps/api/src/services/task.ts";
    const read = (model) => `export const read${model} = ({ db }) => db.${model}.findMany();\n`;
    writeFiles(root, [[service, read("task") + read("project")], EXAMPLES["no-raw-socket"]]);
    expect(lint(root)).toHaveLength(3);

    const output = execFileSync(process.execPath, [BIN, "baseline"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(output).toBe("Wrote 3 violation(s) in 2 file(s) to .quickdraw-lint-baseline.json\n");
    expect(
      JSON.parse(fs.readFileSync(path.join(root, ".quickdraw-lint-baseline.json"), "utf8")),
    ).toEqual({
      version: 1,
      files: {
        [service]: { "no-unbounded-read": 2 },
        [EXAMPLES["no-raw-socket"][0]]: { "no-raw-socket": 1 },
      },
    });
    expect(lint(root)).toEqual([]);

    writeFiles(root, [[service, read("task") + read("project") + read("label")]]);
    expect(lint(root)).toEqual([{ rule: "no-unbounded-read", file: service, line: 3 }]);

    execFileSync(process.execPath, [BIN, "baseline"], { cwd: root, encoding: "utf8" });
    expect(lint(root)).toEqual([]);
  });

  it("refuses an unknown option and explains itself", () => {
    expect(() =>
      execFileSync(process.execPath, [BIN, "baseline", "--nope"], {
        encoding: "utf8",
        stdio: "pipe",
      }),
    ).toThrow(/Unknown option '--nope'/);
    expect(
      execFileSync(process.execPath, [BIN, "baseline", "--help"], { encoding: "utf8" }),
    ).toMatch(/^Usage: quickdraw-lint baseline/);
  });
});
