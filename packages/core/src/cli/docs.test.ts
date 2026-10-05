// `quickdraw-docs` (src/cli/docs.ts): the pages it writes for the end-to-end
// fixture app's contracts (test/fixtures/app.ts) are committed under
// `__docs__/` as a snapshot, which `bun run format:check` also checks, so
// the output stays as oxfmt formats Markdown; the pages it writes with
// `--services` for the access app (`__tests__/accessApp.ts`) under
// `__docs__/access/`. Update them with
// `bun run --filter @fitzzero/quickdraw-core test -- src/cli -u`.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import * as zod3 from "zod3";
import { projectContract, taskContract } from "../../test/fixtures/app";
import { defineContract, listOf, mutation, nullable, query, via } from "../index";
import {
  anyOf,
  custom,
  everyone,
  inherit,
  jsonAcl,
  members,
  owner,
  resolver,
} from "../server/index";
import * as accessApp from "./__tests__/accessApp";
import { accessFormText, policyText, servicesOf } from "./access";
import {
  contractsOf,
  buildHint,
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
const accessModule = relative(packageDir, join(here, "__tests__", "accessApp.ts"));

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
          scope: via({ model: "chatMember", entry: "chatId", scope: "userId", refreshEntry: true }),
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
    expect(page).toContain(
      "`userId` of the `chatMember` rows whose `chatId` is the item's id; a write to those rows sends the item again to every scope that holds it",
    );
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

describe("quickdraw-docs --services (finding F5.3)", () => {
  it("says who may call what, from the services' definitions", async () => {
    const files = generateDocs(contractsOf(accessApp), { services: servicesOf(accessApp) });
    expect([...files.keys()]).toEqual([
      "noteService.md",
      "playerService.md",
      "teamService.md",
      INDEX_FILE,
    ]);
    for (const [name, content] of files) {
      await expect(content).toMatchFileSnapshot(`./__docs__/access/${name}`);
    }
    const team = files.get("teamService.md") ?? "";
    expect(team).toContain(
      "| Row policy         | `anyOf`: the highest level of (`owner`: Admin for the user the `ownerId` column names), (`members`: the role in the user's `teamMember` row (`teamId` names the row, `userId` the user, `role` the role)) |",
    );
    expect(team).toContain('| Change topic       | `"authenticated"`: any signed-in caller');
    expect(team).toContain("| Field levels       | `notes`: Admin");
    expect(team).toContain(
      'Access: `{ entry: "Read" }`: Read or more on the row `input.id` names.',
    );
    expect(team).toContain(
      'Access: `"public"`: anyone, signed in or not.\n\n`rowless`: every caller the form admits may reach any row its input names, on purpose.',
    );
    expect(team).toContain(
      'Access: `{ service: "Admin", entry: "Moderate" }`: a service-wide grant of Admin or more, or Moderate or more on the row `input.id` names.',
    );
    expect(team).toContain(
      "Access: `custom(check)`: a signed-in caller the service's own check lets through.",
    );
    expect(team).toContain(
      'Access: `{ entry: "Read", id: "teamId" }`: Read or more on the row `input.teamId` names.',
    );
    expect(team).toContain("computed by the service when a socket subscribes");
    expect(team).toContain('in development only (`validate: "development"`)');
    expect(team).toContain(
      '| Access   | `{ service: "Read" }`: a service-wide grant of Read or more',
    );
    const players = files.get("playerService.md") ?? "";
    expect(players).toContain(
      "| Row policy         | `inherit`: the level on the `teamService` row the `teamId` column names |",
    );
    expect(players).toContain("passes only the forms that name `service` (`adminBypass: false`)");
    expect(players).toContain(
      'Access: `{ scope: "Moderate", of: teamService, id: "teamId" }`: Moderate or more on the `teamService` row `input.teamId` names.',
    );
    expect(players).toContain("Read or more on the `teamService` row the scope names");
    expect(players).toContain('the subscriber\'s own user id (`scopeAccess: "self"`)');
    expect(players).toContain("closed: the service declares no `watchAccess`");
    expect(files.get("noteService.md")).toContain(
      "The services module defines no `noteService`: who may call its methods is not documented.",
    );
    // Without --services, the pages are the contracts' alone.
    const plain = generateDocs(contractsOf(accessApp)).get("teamService.md") ?? "";
    expect(plain).not.toContain("## Access");
    expect(plain).not.toContain("Access: ");
    // A seed the service computes: known with --services, never "none" without it (finding F6.8).
    expect(plain).not.toContain("computed by the service");
    expect(plain).toContain("none in the contract; the service may compute one");
    expect(plain).not.toContain("none (default)");
    expect(team).not.toContain("the latest few");
    expect(team).toContain("a subscriber starts from the stream's seed");
    // A stream's room forms (the contract's own) are written either way, a seed of one in words.
    for (const page of [team, plain]) {
      expect(page).toContain('`{ room: "lobby" }`');
      expect(page).toContain('`{ room: { prefix: "team:" } }`');
      expect(page).toContain("`{ room: (scope) => ... }`");
      expect(page).toContain("| Seed     | the latest item");
    }
  });

  it("reads the services module from the command line, and checks it", async () => {
    const out = tempDir();
    const written = await run(accessModule, "--services", accessModule, "--out", out);
    expect(written).toMatchObject({ code: 0, err: "" });
    expect(readFileSync(join(out, "teamService.md"), "utf8")).toContain("## Access");
    expect(
      await run(accessModule, "--services", accessModule, "--out", out, "--check"),
    ).toMatchObject({ code: 0, err: "" });
    // The same pages without --services differ: the check names them.
    const plain = await run(accessModule, "--out", out, "--check");
    expect(plain.code).toBe(1);
    expect(plain.err).toContain("teamService.md differs from the contracts");
    expect((await run(accessModule, "--services")).err).toContain("--services needs a module");
    const empty = await run(accessModule, "--services", "src/version.ts", "--out", tempDir());
    expect(empty).toMatchObject({
      code: 1,
      err: "quickdraw-docs: src/version.ts exports no service\n",
    });
  });

  it("says to build the workspace when a package the services import has no build yet (finding F6.7)", () => {
    // A workspace package whose package.json points at its build, not built yet.
    const dir = tempDir();
    const pkg = join(dir, "node_modules", "@project", "db");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@project/db", type: "module", exports: "./dist/index.js" }),
    );
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    const services = join(dir, "services.ts");
    writeFileSync(services, 'import { db } from "@project/db";\nexport const all = [db];\n');
    // Node's own loader, as the command runs (vitest resolves imports its own way).
    const cli = fileURLToPath(new URL("./quickdraw-docs.ts", import.meta.url));
    const tsx = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
    const contracts = fileURLToPath(new URL("./__tests__/accessApp.ts", import.meta.url));
    const result = spawnSync(tsx, [cli, contracts, "--services", services, "--out", tempDir()], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "A workspace package it imports loads from its build, which is missing: build the workspace (bun run build) before generating the docs",
    );
    // Anything else that failed is reported as it was.
    const other = new Error("DATABASE_URL is not set");
    expect(buildHint(other, services, dir)).toBe(other);
  });

  it("refuses a service no contract documents, and two services of one name", () => {
    const services = servicesOf(accessApp);
    expect(() => generateDocs([accessApp.teamContract], { services })).toThrow(
      "the services module defines playerService, but the contracts module exports no contract of that name",
    );
    const twin = { ...accessApp.teamService };
    expect(() => servicesOf({ teamService: accessApp.teamService, twin })).toThrow(
      'two different services are named "teamService"',
    );
    // Found alone, in a list or in a map, once each.
    expect([
      ...servicesOf({
        services: accessApp.services,
        byName: { team: accessApp.teamService },
        notAService: { name: "x" },
      }).keys(),
    ]).toEqual(["playerService", "teamService"]);
  });

  it("writes every access form and row policy", () => {
    const of = defineContract("parentService", { methods: {} });
    expect(accessFormText({ scope: "Read", of, id: (input: unknown) => String(input) })).toBe(
      '`{ scope: "Read", of: parentService, id: (input) => ... }`: Read or more on the `parentService` row a function of the input names',
    );
    expect(accessFormText({ entry: "Admin", id: () => "x" })).toBe(
      '`{ entry: "Admin", id: (input) => ... }`: Admin or more on the row a function of the input names',
    );
    expect(policyText(jsonAcl("acl", { owner: "ownerId" }))).toBe(
      "`jsonAcl`: the level the `acl` column lists for the user, and Admin for the user the `ownerId` column names",
    );
    expect(policyText(jsonAcl("acl"))).toBe(
      "`jsonAcl`: the level the `acl` column lists for the user",
    );
    expect(policyText(resolver({ levelsFor: () => ({}) }))).toBe(
      "`resolver`: the service's own code",
    );
    expect(policyText(everyone("Read"))).toBe(
      "`everyone`: Read for every signed-in user, on every row",
    );
    expect(policyText(inherit({ from: of, via: "parentId" }))).toBe(
      "`inherit`: the level on the `parentService` row the `parentId` column names",
    );
    expect(policyText(anyOf(owner("ownerId"), everyone("Read")))).toBe(
      "`anyOf`: the highest level of (`owner`: Admin for the user the `ownerId` column names), (`everyone`: Read for every signed-in user, on every row)",
    );
    expect(policyText(undefined)).toBe("none: its methods take no `entry` form");
    expect(accessFormText(custom(() => true))).toContain("`custom(check)`");
    expect(policyText(members({ model: "m", entry: "e", user: "u", level: "l" }))).toContain(
      "`members`",
    );
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

  it("says one character, one item and a non-negative integer as such (finding F5.6)", () => {
    const notes = (schema: z.ZodType): string => schemaNotes(jsonSchemaOf(schema, "input") ?? {});
    expect(notes(z.string().min(1))).toBe("at least 1 character");
    expect(notes(z.string().length(1))).toBe("exactly 1 character");
    expect(notes(z.string().max(1))).toBe("at most 1 character");
    expect(notes(z.string().min(1).max(200))).toBe("1 to 200 characters");
    expect(notes(z.array(z.string()).min(1))).toBe("at least 1 item");
    expect(notes(z.array(z.string()).max(3))).toBe("at most 3 items");
    expect(notes(z.number().int())).toBe("");
    expect(notes(z.number().int().nonnegative())).toBe("non-negative");
    expect(notes(z.number().nonnegative())).toBe("non-negative");
    expect(notes(z.number().int().positive())).toBe("positive");
    expect(notes(z.number().negative())).toBe("negative");
    expect(notes(z.number().int().nonpositive())).toBe("non-positive");
    expect(notes(z.number().int().min(1))).toBe("at least 1");
    expect(notes(z.number().int().max(10))).toBe("at most 10");
    expect(notes(z.number().int().gt(5))).toBe("more than 5");
    expect(notes(z.number().lt(5))).toBe("less than 5");
    expect(notes(z.number().int().min(1).max(200))).toBe("1 to 200");
    expect(notes(z.number().int().min(0).lt(10))).toBe("non-negative, less than 10");
  });
});
