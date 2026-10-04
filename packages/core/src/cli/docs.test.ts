// `quickdraw-docs` (src/cli/docs.ts): the pages it writes for the end-to-end
// fixture app's contracts (test/fixtures/app.ts) are committed under
// `__docs__/` as a snapshot, which `bun run format:check` also checks, so
// the output stays as oxfmt formats Markdown. Update it with
// `bun run --filter @fitzzero/quickdraw-core test -- src/cli -u`.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import * as zod3 from "zod3";
import { projectContract, taskContract } from "../../test/fixtures/app";
import { defineContract, listOf, mutation, nullable, query, via } from "../index";
import {
  contractsOf,
  failedToLoad,
  generateDocs,
  INDEX_FILE,
  main,
  syncDocs,
  type DocsOutput,
} from "./docs";
import { GENERATED_MARKER } from "./render";
import { jsonSchemaOf, schemaFields, schemaNotes, schemaText } from "./schemaText";

const here = fileURLToPath(new URL(".", import.meta.url));
const packageDir = join(here, "..", "..");
const fixtureModule = relative(packageDir, join(packageDir, "test", "fixtures", "app.ts"));

const temporary: string[] = [];
afterAll(() => {
  for (const dir of temporary) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "quickdraw-docs-"));
  temporary.push(dir);
  return dir;
}

/** Runs the command in the package directory, collecting what it prints. */
async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io: DocsOutput = {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  };
  const code = await main(args, io, packageDir);
  return { code, out, err };
}

describe("quickdraw-docs", () => {
  it("documents the fixture app's contracts", async () => {
    const files = generateDocs(contractsOf({ projectContract, taskContract }));
    expect([...files.keys()]).toEqual(["projectService.md", "taskService.md", INDEX_FILE]);
    for (const [name, content] of files) {
      await expect(content).toMatchFileSnapshot(`./__docs__/${name}`);
    }
  });

  it("--check passes after generation and fails after a contract change", async () => {
    const out = tempDir();
    const written = await run(fixtureModule, "--out", out);
    expect(written).toMatchObject({ code: 0, err: "" });
    expect(written.out).toContain("3 written, 0 unchanged, 0 removed");
    expect(await run(fixtureModule, "--out", out, "--check")).toMatchObject({ code: 0, err: "" });

    // A contract that gained a method no longer matches its page.
    const changed = Object.freeze({
      ...taskContract,
      methods: {
        ...taskContract.methods,
        archive: mutation({ input: z.string(), output: z.null() }),
      },
    });
    const report = syncDocs(generateDocs([projectContract, changed]), out, true);
    expect(report).toEqual({
      written: ["taskService.md", INDEX_FILE],
      unchanged: ["projectService.md"],
      removed: [],
    });
    expect(readFileSync(join(out, "taskService.md"), "utf8")).not.toContain("archive");

    // So does a page edited by hand.
    writeFileSync(join(out, "projectService.md"), `${GENERATED_MARKER}\n\n# edited\n`);
    const check = await run(fixtureModule, "--out", out, "--check");
    expect(check.code).toBe(1);
    expect(check.err).toContain("projectService.md differs from the contracts");
    expect(check.err).toContain("1 page(s) out of date");
  });

  it("removes the pages of services no contract has, and leaves other files alone", async () => {
    const out = tempDir();
    writeFileSync(join(out, "oldService.md"), `${GENERATED_MARKER}\n\n# oldService\n`);
    writeFileSync(join(out, "guide.md"), "# Written by hand\n");
    const check = await run(fixtureModule, "--out", out, "--check");
    expect(check.code).toBe(1);
    expect(check.err).toContain("oldService.md documents a service no contract has");

    expect((await run(fixtureModule, "--out", out)).out).toContain("1 removed");
    expect(() => readFileSync(join(out, "oldService.md"))).toThrow();
    expect(readFileSync(join(out, "guide.md"), "utf8")).toBe("# Written by hand\n");
  });

  it("never replaces a file it did not write", async () => {
    const out = tempDir();
    writeFileSync(join(out, INDEX_FILE), "# Our API\n");
    const result = await run(fixtureModule, "--out", out);
    expect(result.code).toBe(1);
    expect(result.err).toContain("README.md in");
    expect(result.err).toContain("was not written by quickdraw-docs");
    expect(readFileSync(join(out, INDEX_FILE), "utf8")).toBe("# Our API\n");
    expect(() => readFileSync(join(out, "taskService.md"))).toThrow();
  });

  it("finds contracts exported alone or in a map, once each", () => {
    const contracts = contractsOf({
      taskContract,
      contracts: { task: taskContract, project: projectContract },
      qd: { notAContract: true },
      count: 3,
    });
    expect(contracts.map((contract) => contract.name)).toEqual(["projectService", "taskService"]);
    const twin = defineContract("taskService", { methods: {} });
    expect(() => contractsOf({ taskContract, twin })).toThrow(
      'two different contracts are named "taskService"',
    );
  });

  it("answers usage errors and modules without contracts", async () => {
    expect((await run()).code).toBe(2);
    expect((await run(fixtureModule, "--out")).err).toContain("--out needs a directory");
    expect((await run("--help")).out).toMatch(/^Usage: quickdraw-docs <module>/);
    const empty = await run("src/version.ts", "--out", tempDir(), "--check");
    expect(empty).toMatchObject({
      code: 1,
      err: "quickdraw-docs: src/version.ts exports no contract\n",
    });
  });

  it("reports the error of a module that throws, once, running it once (the review's docs case)", async () => {
    const dir = tempDir();
    const ran = join(dir, "ran.log");
    const throwing = join(dir, "throws.ts");
    writeFileSync(
      throwing,
      [
        'import { appendFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(ran)}, "ran\\n");`,
        'throw new Error("the contracts module failed: DATABASE_URL is not set");',
        "",
      ].join("\n"),
    );
    // Run from the package, where tsx is installed: it must not load the module again.
    expect(await run(throwing, "--out", tempDir())).toEqual({
      code: 1,
      out: "",
      err: "quickdraw-docs: the contracts module failed: DATABASE_URL is not set\n",
    });
    expect(readFileSync(ran, "utf8")).toBe("ran\n");
  });

  it("loads a module through tsx only when Node's loader could not", () => {
    const coded = (code: string) => Object.assign(new Error(code), { code });
    for (const code of [
      "ERR_MODULE_NOT_FOUND",
      "ERR_UNSUPPORTED_DIR_IMPORT",
      "ERR_UNKNOWN_FILE_EXTENSION",
      "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX",
    ]) {
      expect(failedToLoad(coded(code))).toBe(true);
    }
    expect(failedToLoad(new Error("DATABASE_URL is not set"))).toBe(false);
    expect(failedToLoad(coded("ECONNREFUSED"))).toBe(false);
    expect(failedToLoad("thrown string")).toBe(false);
  });

  it("writes every kind of member a contract can declare", () => {
    const item = z.object({ id: z.string(), name: z.string().describe("Shown in lists") });
    const chat = defineContract("chatService", {
      entity: item.extend({ secret: z.string(), archived: z.boolean() }),
      projections: { item },
      fields: { secret: "Admin" },
      methods: {
        find: query({ input: z.object({ id: z.string() }), output: nullable("item") }),
        all: query({ input: z.undefined(), output: listOf("item") }),
        legacy: query({ input: zod3.z.object({ id: zod3.z.string() }), output: zod3.z.string() }),
      },
      collections: {
        mine: {
          scope: via({ model: "chatMember", entry: "chatId", scope: "userId" }),
          item: "item",
          order: [["id", "asc"]],
          where: { archived: false },
          access: "Moderate",
        },
      },
      streams: { log: { item: z.string(), scope: "chatId", seed: 10, access: { entry: "Read" } } },
      channels: {
        typing: { payload: z.object({ chatId: z.string() }), requires: { entity: "chatId" } },
        wave: { payload: z.object({ n: z.number() }), requires: { room: "lounge" } },
        nudge: {
          payload: z.object({ lobby: z.string() }),
          requires: { room: (payload) => `lobby:${payload.lobby}` },
        },
      },
      events: { joined: { payload: z.object({ userId: z.string() }) } },
    });
    const page = generateDocs([chat]).get("chatService.md") ?? "";
    expect(page).toMatch(/\| `secret` +\| `string` +\| Admin +\|/);
    expect(page).toContain("Output: one row as the `item` projection, or `null`.");
    expect(page).toContain("Input: none.");
    expect(page).toContain("Output: rows as the `item` projection.");
    expect(page).toContain("Input: `unknown (no JSON Schema)`.");
    expect(page).toContain("`userId` of the `chatMember` rows whose `chatId` is the item's id");
    expect(page).toContain("`archived = false`");
    expect(page).toContain("one feed per `chatId`");
    expect(page).toContain('`{ entry: "Read" }`');
    expect(page).toContain("a subscription to the row `chatId` names");
    expect(page).toContain("the sending socket in the app room `lounge`");
    expect(page).toContain("the sending socket in the app room a function of the payload names");
    expect(page).toContain("Shown in lists");
    expect(page.startsWith(`${GENERATED_MARKER}\n\n# chatService\n`)).toBe(true);
  });
});

describe("schema text", () => {
  const text = (schema: z.ZodType): string => schemaText(jsonSchemaOf(schema, "output") ?? {});

  it("writes JSON Schema as TypeScript-like types", () => {
    expect(text(z.object({ id: z.string(), n: z.number().int().optional() }))).toBe(
      "{ id: string; n?: integer }",
    );
    expect(text(z.array(z.union([z.string(), z.null()])))).toBe("(string | null)[]");
    expect(text(z.array(z.object({ a: z.literal("x | y") })))).toBe('{ a: "x | y" }[]');
    expect(text(z.enum(["a", "b"]))).toBe('"a" | "b"');
    expect(text(z.record(z.string(), z.boolean()))).toBe("Record<string, boolean>");
    expect(text(z.tuple([z.string(), z.number()]))).toBe("[string, number]");
    expect(text(z.object({ "not-an-identifier": z.unknown() }))).toBe(
      '{ "not-an-identifier": unknown }',
    );
  });

  it("writes a recursive schema's name where it refers to itself", () => {
    interface Node {
      readonly children: Node[];
    }
    const node: z.ZodType<Node> = z.object({ children: z.array(z.lazy(() => node)) });
    expect(text(node)).toBe("{ children: Self[] }");
    const named: z.ZodType<Node> = z
      .object({ children: z.array(z.lazy(() => named)) })
      .meta({ id: "TreeNode" });
    expect(text(z.object({ root: named }))).toBe("{ root: { children: TreeNode[] } }");
  });

  it("notes ranges, formats, defaults and descriptions, and lists object fields", () => {
    const json = jsonSchemaOf(
      z.object({
        limit: z.number().int().min(1).max(200).default(50),
        at: z.iso.datetime().describe("When it happened"),
      }),
      "input",
    );
    expect(json === undefined ? undefined : schemaFields(json)).toEqual([
      { name: "limit", optional: true, type: "integer", notes: "1 to 200; default 50" },
      {
        name: "at",
        optional: false,
        type: "string",
        notes: "format date-time; When it happened",
      },
    ]);
    expect(schemaNotes({ minLength: 2 })).toBe("at least 2 characters");
  });
});
