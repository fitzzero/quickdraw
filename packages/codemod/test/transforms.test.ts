// The codemod on the 4.1 fixture app (test/fixtures/v4-app): the output and
// the report match the committed snapshot (test/fixtures/v4-app.expected;
// `vitest run -u` rewrites it, and a file the codemod stops writing must be
// deleted from it by hand), the access mapping writes the four forms the 4.x
// semantics call for, a placeholder input lists its payload's keys (so
// `defineService`'s rowless check sees an id among them), the report lists
// every manual item of the fixture at its file and line, a service class's
// fields, getters, constructor and overrides survive as marked module code,
// an inline import() type names its module from the contract file, moved
// schemas of one name are merged or renamed and an aliased one is written by
// its declared name, a method object whose name its module or service file
// binds already gets that name free (or another name, beside an exported
// binding), and a second run changes nothing.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Node, Project, SyntaxKind } from "ts-morph";
import { z } from "zod";
import { defineContract, query, type StandardSchemaV1, todoSchema } from "@fitzzero/quickdraw-core";
import { initQuickdraw, resolver } from "@fitzzero/quickdraw-core/server";
// @ts-expect-error -- the lint plugin is plain JavaScript without types
import { kitShape as preferKit } from "../../lint/plugin/rules/prefer-kit.mjs";
import { moduleName } from "../src/hoist";
import { runCodemod, type RunResult } from "../src/index";
import { kitShapeOf } from "../src/kits";
import { findMarkers, MARKER } from "../src/markers";
import { REPORT_FILE } from "../src/report";
import { copyFixture, EXPECTED, FIXTURE, readTree, removeCopies } from "./helpers";

let root = "";
let result: RunResult;
let output = new Map<string, string>();

beforeAll(() => {
  root = copyFixture("transforms");
  result = runCodemod({ root });
  output = readTree(root);
});

afterAll(() => {
  removeCopies();
});

describe("the output on the 4.1 fixture app", () => {
  it("matches the committed snapshot, file by file", async () => {
    for (const [file, text] of output) {
      await expect(text, file).toMatchFileSnapshot(join(EXPECTED, file));
    }
  });

  it("writes no file the snapshot lacks, and leaves none of its files out", () => {
    // `vitest run -u` writes new snapshot files, but never deletes stale ones
    const expected = existsSync(EXPECTED) ? [...readTree(EXPECTED).keys()] : [...output.keys()];
    expect([...output.keys()]).toEqual(expected);
  });

  it("converts every service, method and hook call, and deletes the wrapper hooks", () => {
    expect(result.stats).toEqual({
      services: 5,
      methods: 31,
      aggregatorsRemoved: 2,
      contracts: 5,
      schemasMoved: 18,
      schemasMerged: 1,
      schemasRenamed: 1,
      todoSchemas: 31,
      clientCalls: 8,
      wrappersDeleted: 3,
    });
    // the file an aggregator left empty, the wrappers, and the file of types only they imported
    expect(result.deleted.toSorted()).toEqual([
      "apps/api/src/services/task/methods/index.ts",
      "apps/web/src/hooks/service-types.ts",
      "apps/web/src/hooks/useService.ts",
      "apps/web/src/hooks/useServiceQuery.ts",
      "apps/web/src/hooks/useSubscription.ts",
    ]);
    expect(output.has("packages/shared/src/contracts/index.ts")).toBe(true);
  });

  it("changes nothing the second time it runs", () => {
    const again = runCodemod({ root });
    expect({ changed: again.changed, created: again.created, deleted: again.deleted }).toEqual({
      changed: [],
      created: [],
      deleted: [],
    });
    expect(readTree(root)).toEqual(output);
    expect(again.report).toBe(result.report);
  });
});

describe("method modules that take a port of the service", () => {
  const archive = "apps/api/src/services/task/methods/archive.ts";

  it("give each method a contract entry and a typed method object, whatever the port's shape", () => {
    // Pick<BaseService<..., TaskServiceMethods, ...>, ...> & { ... } (task/service-ports.ts)
    const archived = output.get(archive) ?? "";
    expect(archived).toContain('satisfies MethodOf<typeof taskContract, "archiveTask">');
    expect(archived).toContain('satisfies MethodOf<typeof taskContract, "listArchivedTasks">');
    expect(output.get("packages/shared/src/contracts/task.ts")).toMatch(
      /^ {4}archiveTask: mutation/mu,
    );
    // an interface extending Pick<ProjectService, ...>, through a type parameter's constraint
    expect(output.get("apps/api/src/services/project-methods/limits.ts")).toContain(
      'satisfies MethodOf<typeof projectContract, "getProjectLimits">',
    );
    expect(output.get("apps/api/src/services/project.ts")).toMatch(/^ {4}getProjectLimits,$/mu);
    expect(output.get(REPORT_FILE)).not.toContain("no defineMethod call implements");
  });

  it("mark the port itself, which typed the instance the service no longer is", () => {
    const ports = findMarkers(output.get("apps/api/src/services/task/service-ports.ts") ?? "", "")
      .concat(findMarkers(output.get("apps/api/src/services/project-methods/limits.ts") ?? "", ""))
      .filter((marker) => marker.message.includes("was a port of the 4.x"))
      .map((marker) => marker.message.split(" ")[0]);
    expect(ports).toEqual(["TaskServicePort", "ProjectLimitsPort"]);
  });

  it("name where a defineMethod call tied to no service sits, in the contract's unimplemented marker", () => {
    const untied = copyFixture("untied");
    const file = join(untied, archive);
    const text = readFileSync(file, "utf8");
    writeFileSync(
      file,
      text.replace(
        "registerArchive(service: TaskServicePort)",
        'registerArchive(service: { defineMethod: TaskServicePort["defineMethod"] })',
      ),
    );
    runCodemod({ root: untied });
    const contract = readFileSync(join(untied, "packages/shared/src/contracts/task.ts"), "utf8");
    expect(contract).toContain(
      `names archiveTask, listArchivedTasks, which no defineMethod call implements: add them here and in the service, or drop them. A defineMethod call on a receiver the codemod could not tie to a service (its parameter's type) probably holds the handler: archiveTask at ${archive}:13, listArchivedTasks at ${archive}:29`,
    );
  });
});

describe("aggregators, the functions that call method modules' register functions", () => {
  const task = "apps/api/src/services/task";
  /** The register and aggregator functions the fixture declares. */
  const declared = [...readTree(FIXTURE)].flatMap(([file, text]) =>
    file.startsWith("apps/api/")
      ? [...text.matchAll(/^export function ((?:register|define)\w+)/gmu)].map(
          (match) => match[1] ?? "",
        )
      : [],
  );

  it("go when they do nothing else, with their calls and a file one leaves empty", () => {
    // task/methods/index.ts held only defineTaskMethods, which the constructor called; it
    // called a module typed by the class, one typed by a port, and two more aggregators
    expect(output.has(`${task}/methods/index.ts`)).toBe(false);
    // defineTaskQueries sat beside the modules it called, which became method objects
    expect(output.get(`${task}/methods/queries.ts`)).not.toContain("defineTaskQueries");
    expect(output.get(`${task}/methods/queries.ts`)).toMatch(
      /^export const listTasks = [^]*^export const reindexProject = /mu,
    );
    // no code left calls a function the run removed, nor the aggregator it kept
    expect(declared).toHaveLength(10);
    const call = new RegExp(`\\b(?:${declared.join("|")})\\(`, "u");
    const calls = [...output].flatMap(([file, text]) =>
      text
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("//") && call.test(line))
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(calls).toEqual([
      `${task}/methods/update-task.ts: export function defineEditMethods(service: typeof taskService): void {`,
    ]);
  });

  it("stay under the register-leftover marker when they do more, without the calls it names", () => {
    expect(output.get(`${task}/methods/update-task.ts`)).toContain(
      [
        "// Registers the edit methods, and says so: more than registering",
        `// ${MARKER} [this] defineEditMethods also did more than register methods (the codemod removed its call of registerUpdateTasks, whose methods the service lists now): a service object is not passed around any more; move what still matters, then delete it`,
        "export function defineEditMethods(service: typeof taskService): void {",
        '  console.info("task edit methods registered");',
        "}",
      ].join("\n"),
    );
    // a review item with its file and line
    expect(output.get(REPORT_FILE)).toMatch(
      /^- \[ \] `apps\/api\/src\/services\/task\/methods\/update-task\.ts:\d+` defineEditMethods also did more than register methods/mu,
    );
  });

  it("are found through import aliases, keep a file they empty while it is imported, and register functions lose their calls of others", () => {
    const variant = copyFixture("aggregators");
    const edit = (file: string, from: string, to: string): void => {
      const path = join(variant, file);
      const text = readFileSync(path, "utf8");
      expect(text, file).toContain(from);
      writeFileSync(path, text.replace(from, to));
    };
    // the aggregator names a module by another name
    edit(
      `${task}/methods/index.ts`,
      'import { registerArchive } from "./archive.js";',
      'import { registerArchive as archiveMethods } from "./archive.js";',
    );
    edit(`${task}/methods/index.ts`, "registerArchive(service);", "archiveMethods(service);");
    // test code still imports the aggregator's file
    writeFileSync(
      join(variant, `${task}/__tests__/wiring.test.ts`),
      'import { defineTaskMethods } from "../methods/index.js";\n\nexport const wiring = defineTaskMethods;\n',
    );
    // a register function whose only other statement calls another one
    edit(
      `${task}/methods/queries.ts`,
      "    { schema: projectIdSchema },\n  );\n}",
      "    { schema: projectIdSchema },\n  );\n  registerReindexProject(service);\n}",
    );
    // and one that does more, calling another one under a condition
    edit(
      `${task}/methods/create-task.ts`,
      'import type { TaskService } from "../index.js";',
      'import type { TaskService } from "../index.js";\nimport { registerArchive } from "./archive.js";',
    );
    edit(
      `${task}/methods/create-task.ts`,
      "    { schema: createTaskSchema },\n  );\n}",
      '    { schema: createTaskSchema },\n  );\n  if (process.env.NODE_ENV !== "production") registerArchive(service);\n  console.info("createTask registered");\n}',
    );
    const run = runCodemod({ root: variant });
    const read = (file: string): string => readFileSync(join(variant, file), "utf8");
    expect(run.stats.aggregatorsRemoved).toBe(2);
    expect(run.deleted).not.toContain(`${task}/methods/index.ts`);
    expect(read(`${task}/methods/index.ts`).trim()).toBe("");
    expect(read(`${task}/methods/queries.ts`)).not.toMatch(/register(?:ListTasks|ReindexProject)/u);
    const create = read(`${task}/methods/create-task.ts`);
    expect(create).toContain(
      `// ${MARKER} [this] registerCreateTask also did more than register methods (the codemod removed its call of registerArchive, whose methods the service lists now): a service object is not passed around any more; move what still matters, then delete it\nexport function registerCreateTask(`,
    );
    expect(create).toMatch(/^ {2}if \(process\.env\.NODE_ENV !== "production"\) \{ ?\}\n/mu);
    expect(create).not.toContain("registerArchive(");
  });
});

describe("a method object whose name its files bind already (task/methods/delegates.ts, task/index.ts)", () => {
  const task = "apps/api/src/services/task";
  const delegates = (): string => output.get(`${task}/methods/delegates.ts`) ?? "";
  const service = (): string => output.get(`${task}/index.ts`) ?? "";

  it("renames what the method module owns of the name: a local helper <name>Body, an import <name>Impl", () => {
    expect(delegates()).toContain(
      "async function renameTaskBody(db: PrismaClient, id: string, title: string) {",
    );
    expect(delegates()).toContain("const task = await renameTaskBody(db, input.id, input.title);");
    expect(delegates()).toContain('import { assignTask as assignTaskImpl } from "../rows.js";');
    expect(delegates()).toContain(
      "const task = await assignTaskImpl(db, input.id, input.assigneeId);",
    );
    expect(
      delegates().match(/^export const (?:assignTask|renameTask|countTasks) = \{$/gmu),
    ).toHaveLength(3);
    // and an exported helper keeps its name, for the files that import it: the object takes another
    expect(delegates()).toContain(
      "export async function getTaskTitle(db: PrismaClient, id: string)",
    );
    expect(delegates()).toContain("export const getTaskTitleMethod = {");
    expect(delegates()).toContain("title: await getTaskTitle(db, input.id),");
    expect(service()).toMatch(/^ {4}getTaskTitle: getTaskTitleMethod,$/mu);
    expect(service()).toContain("return (await getTaskTitle(db, id)) ?? id;");
  });

  it("aliases the service file's import of an implementation under a method's name <name>Impl", () => {
    expect(service()).toContain('import { assignTask as assignTaskImpl } from "./rows.js";');
    expect(service()).toContain("await assignTaskImpl(db, id, userId);");
    expect(service()).toMatch(/^ {4}assignTask,$/mu);
  });

  it("imports the method object as <name>Method where the service file declares the name itself", () => {
    expect(service()).toContain("renameTask as renameTaskMethod");
    expect(service()).toMatch(/^ {4}renameTask: renameTaskMethod,$/mu);
    expect(service()).toContain(
      "export async function renameTask(db: PrismaClient, id: string, title: string): Promise<void> {",
    );
  });

  it("hoists a service's helper of a module method's name as <name>Of<Class>, where its callers import it", () => {
    // task/service-core.ts's countTasks, which the countTasks handler called on the service
    expect(output.get(`${task}/service-core.ts`)).toContain(
      "export async function countTasksOfTaskServiceCore(projectId: string): Promise<number> {",
    );
    expect(delegates()).toContain(
      'import { toTaskDto, countTasksOfTaskServiceCore } from "../service-core.js";',
    );
    expect(delegates()).toContain("count: await countTasksOfTaskServiceCore(input.projectId),");
  });

  it("renames a binding inside a function that would shadow an imported method object <name>Impl", () => {
    expect(service()).toContain(
      'const { countTasks: countTasksImpl } = await import("./rows.js");',
    );
    expect(service()).toContain("return await countTasksImpl(db, projectId);");
    expect(service()).toMatch(/^ {4}countTasks,$/mu);
  });
});

describe("a 4.x service class's members (label.ts)", () => {
  const label = (): string => output.get("apps/api/src/services/label.ts") ?? "";

  it("keeps every field as a marked module binding, with its initializer", () => {
    expect(label()).toMatch(
      /\[this\] 4\.x instance field renamed of LabelService: now module state[^\n]*\nconst renamed = new Set<string>\(\);/u,
    );
    expect(label()).toMatch(
      /\[this\] 4\.x instance field onChange[^\n]*\nlet onChange: LabelListener \| undefined;/u,
    );
    // a method binds a local `room`, so the field's binding takes another name
    expect(label()).toMatch(
      /\[this\] 4\.x instance field room[^\n]*\nexport let roomOfLabelService: string;/u,
    );
    // uses of the fields read the bindings
    expect(label()).toContain("renamed.add(label.id);");
    expect(label()).toContain("const room = roomOfLabelService;");
    expect(label()).not.toMatch(/this\.(?:renamed|onChange|room)\b/u);
  });

  it("writes a function field the class replaces as a marked let, and keeps a fixed one a const", () => {
    // setNamer replaces namer: module state, like any field the class writes after its initializer
    expect(label()).toMatch(
      /\[this\] 4\.x instance field namer of LabelService: now module state[^\n]*\nlet namer: LabelNamer = \(projectId\) => `label-\$\{projectId\}`;/u,
    );
    expect(label()).toContain(
      "export function setNamer(next: LabelNamer): void {\n  namer = next;",
    );
    // a readonly one, and one nothing writes, stay unmarked consts
    expect(label()).toContain(
      "// How a name is tidied, for good\nconst tidy = (name: string): string => name.trim();",
    );
    expect(label()).toContain(
      "// How a name becomes a key, typed by its field, which nothing swaps\nconst slug: (name: string) => string = (name) => name.toLowerCase();",
    );
  });

  it("keeps a function field's type on its const, which its untyped parameters rely on", () => {
    expect(label()).toContain(
      "const slug: (name: string) => string = (name) => name.toLowerCase();",
    );
  });

  it("writes a readonly field its constructor overwrites as a marked let, which the setup function sets", () => {
    expect(label()).toMatch(
      /\[this\] 4\.x instance field limit of LabelService: now module state[^\n]*\nlet limit: number = 100;/u,
    );
    expect(label()).toContain(
      "  if (options.limit !== undefined) {\n    limit = options.limit;\n  }",
    );
  });

  it("renames a binding outside the class that would shadow a hoisted field <name>Impl, the field keeping its name", () => {
    expect(label()).toContain(
      "export function notifyLabel(onChangeImpl: LabelListener | undefined, labelId: string): void {\n  onChangeImpl?.(labelId);",
    );
    expect(label()).toMatch(/^let onChange: LabelListener \| undefined;$/mu);
  });

  it("keeps the constructor's assignments in a setup function that takes the parameters they use", () => {
    expect(label()).toContain(
      "export function setUpLabelService(options: { onChange?: LabelListener; limit?: number } = {}): void {\n  onChange = options.onChange;",
    );
  });

  it("hoists a getter into a function, which its reads call", () => {
    expect(label()).toContain("export function renamedCount(): number {\n  return renamed.size;");
  });

  it("drops a call of the 4.x base class under a marker that names it: super does not parse outside a class", () => {
    const code = label()
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"));
    expect(code.filter((line) => /\bsuper\b/u.test(line))).toEqual([]);
    expect(label()).toContain(
      "// quickdraw-migrate: review [this] dropped super.unsubscribeSocket(socket), a call of the 4.x base class",
    );
    expect(label()).toMatch(
      /\[this\] super\.adminCreate\(data\) called the 4\.x base class[^\n]*\n {2}const created = await undefined;/u,
    );
  });

  it("hoists a member named after a reserved word (delete) as <name>Of<Class>, and its calls follow", () => {
    expect(label()).not.toMatch(/function delete\b/u);
    expect(label()).toMatch(
      /overrode the 4\.x BaseService method delete[^\n]*; hoisted as deleteOfLabelService: delete is a reserved word\nasync function deleteOfLabelService\(id: string\)/u,
    );
    expect(label()).toContain("return await deleteOfLabelService(id);");
    // and the file parses
    const project = new Project({ useInMemoryFileSystem: true });
    const file = project.createSourceFile("label.ts", label());
    expect(project.getProgram().getSyntacticDiagnostics(file)).toEqual([]);
  });

  it("marks this.constructor as instance state, not as a key of Object.prototype", () => {
    expect(label()).toMatch(
      /\[this\] this\.constructor was 4\.x service-instance state[^\n]*\n {2}return this\.constructor\.name;/u,
    );
  });

  it("puts a marker about a one-line literal above the statement holding it", () => {
    expect(label()).toMatch(
      /\[this\] this\.subscribers was 4\.x service-instance state[^\n]*\n {2}return \{ room, sockets: this\.subscribers/u,
    );
  });
});

describe("a handler's thrown errors", () => {
  it("marks each throw new Error, whose message 5.0 no longer sends, but not a guard the codemod dropped", () => {
    const user = output.get("apps/api/src/services/user.ts") ?? "";
    expect(user).toMatch(
      /\[error\] 4\.x sent this error's message to the caller[^\n]*QuickdrawError[^\n]*\n\s*throw new Error\("Cannot update other users"\);/u,
    );
    const create = output.get("apps/api/src/services/task/methods/create-task.ts") ?? "";
    // The `if (!ctx.userId) throw ...` guard the access form makes needless is dropped, unmarked.
    expect(create).not.toContain("Authentication required");
    expect(create.match(/\[error\]/gu)).toHaveLength(1);
    const report = output.get(REPORT_FILE) ?? "";
    expect(report).toContain("## Errors the caller no longer sees");
  });
});

describe("the web app's 4.x types", () => {
  it("drop a local type only a rewritten hook call's type arguments named", () => {
    const text = output.get("apps/web/src/components/RenameLabel.tsx") ?? "";
    expect(text).not.toContain("RenameLabelPayload");
    expect(text).not.toContain("type argument: nothing else names it");
  });

  it("give a one-argument UseCollectionResult 5.0's second argument", () => {
    expect(output.get("apps/web/src/hooks/useMyProjects.ts")).toContain(
      "export function useMyProjects(): UseCollectionResult<ProjectListItem, { readonly id: string }> {",
    );
  });
});

/** The access form of method `method` in the output, and the markers right above it. */
function accessOf(method: string): { form: string; markers: string[] } {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [file, text] of output) {
    if (!file.startsWith("apps/api/src/services/")) {
      continue;
    }
    const source = project.createSourceFile(file, text);
    for (const object of source.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
      const parent = object.getParent();
      const named =
        (Node.isPropertyAssignment(parent) && parent.getName() === method) ||
        (Node.isSatisfiesExpression(parent) &&
          parent.getParent()?.getText().startsWith(`${method} =`) === true);
      const access = named ? object.getProperty("access") : undefined;
      if (access !== undefined && Node.isPropertyAssignment(access)) {
        const markers = access.getLeadingCommentRanges().map((range) => range.getText());
        return { form: access.getInitializerOrThrow().getText(), markers };
      }
    }
  }
  throw new Error(`no method ${method} in the output`);
}

describe("the access mapping", () => {
  it('writes "public" for a "Public" method', () => {
    expect(accessOf("ping")).toEqual({ form: '"public"', markers: [] });
  });

  it("writes { service: L, entry: L, id } for a method with a row id, never { entry: L }", () => {
    // an explicit resolveEntryId reading one key
    expect(accessOf("getMembers").form).toBe('{ service: "Read", entry: "Read", id: "projectId" }');
    expect(accessOf("moveTask").form).toBe(
      '{ service: "Moderate", entry: "Moderate", id: "taskId" }',
    );
    // no resolveEntryId: 4.x read payload.id implicitly
    expect(accessOf("getProject").form).toBe('{ service: "Read", entry: "Read", id: "id" }');
    expect(accessOf("deleteProject").form).toBe('{ service: "Admin", entry: "Admin", id: "id" }');
    expect(accessOf("updateTask").form).toBe(
      '{ service: "Moderate", entry: "Moderate", id: "id" }',
    );
    // a resolveEntryId that is more than a key stays a function, marked
    expect(accessOf("renameLabel").form).toBe(
      '{ service: "Moderate", entry: "Moderate", id: (input) => ((p) => p.labelId ?? null)(input) ?? "" }',
    );
    expect(accessOf("renameLabel").markers.join("\n")).toContain(
      `${MARKER} [access] 4.x's resolveEntryId was a function`,
    );
  });

  it('writes "authenticated" with a review marker for "Read" without a row id', () => {
    for (const method of [
      "createProject",
      "listMyProjects",
      "getMe",
      "createTask",
      "listTasks",
      "listLabels",
    ]) {
      const { form, markers } = accessOf(method);
      expect(form, method).toBe('"authenticated"');
      expect(markers.join("\n"), method).toContain(
        `${MARKER} [access] "Read" with no row id let every signed-in user call this in 4.x`,
      );
    }
  });

  it('writes "public" with rowless: true for a "Public" method whose input has an id', () => {
    const { form, markers } = accessOf("getProfile");
    expect(form).toBe('"public"');
    expect(markers.join("\n")).toContain(
      `${MARKER} [access] this method takes an id but its access "public" checks no row`,
    );
    expect(output.get("apps/api/src/services/user.ts")).toContain(
      'access: "public",\n      rowless: true,\n',
    );
    // and for one whose input is a placeholder, which lists the id among its keys
    expect(accessOf("getLabelName").form).toBe('"public"');
    expect(output.get("apps/api/src/services/label.ts")).toContain(
      'access: "public",\n      rowless: true,\n',
    );
    // a method without an id, or with a form that checks its row, needs no rowless
    const code = [...output].filter(([file]) => file.startsWith("apps/api/"));
    expect(code.flatMap(([, text]) => text.match(/^\s*rowless: true,$/gmu) ?? [])).toHaveLength(2);
  });

  it('writes { service: L } for "Moderate" or "Admin" without a row id', () => {
    expect(accessOf("stats")).toEqual({ form: '{ service: "Admin" }', markers: [] });
    expect(accessOf("deleteAllLabels")).toEqual({ form: '{ service: "Admin" }', markers: [] });
    expect(accessOf("reindexProject")).toEqual({ form: '{ service: "Moderate" }', markers: [] });
  });

  it("keeps every service name exactly, since stored grants name them", () => {
    const names = [...output.values()].join("\n").match(/defineContract\("(\w+)"/gu);
    expect(names).toEqual([
      'defineContract("healthService"',
      'defineContract("labelService"',
      'defineContract("projectService"',
      'defineContract("taskService"',
      'defineContract("userService"',
    ]);
  });
});

/** The contract input of `method`, as code. */
function inputOf(method: string): string {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [file, text] of output) {
    if (!file.startsWith("packages/shared/src/contracts/")) {
      continue;
    }
    const source = project.createSourceFile(file, text);
    for (const property of source.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
      const call = property.getInitializer();
      if (property.getName() !== method || !Node.isCallExpression(call)) {
        continue;
      }
      const [options] = call.getArguments();
      const input = Node.isObjectLiteralExpression(options)
        ? options.getProperty("input")
        : undefined;
      if (input !== undefined && Node.isPropertyAssignment(input)) {
        return input.getInitializerOrThrow().getText();
      }
    }
  }
  throw new Error(`no method ${method} in the contracts`);
}

/** Calls defineService the way untyped JavaScript would. */
const defineLoosely = initQuickdraw().defineService as unknown as (
  contract: unknown,
  definition: unknown,
) => unknown;

describe("a placeholder input", () => {
  it("lists the 4.x payload type's keys, an id among them", () => {
    expect(inputOf("getLabel")).toBe('todoSchema<{ id: string }>({ keys: ["id"] })');
    expect(inputOf("getLabelName")).toBe('todoSchema<{ id: string }>({ keys: ["id"] })');
    expect(inputOf("archiveProject")).toBe('todoSchema<{ id: string }>({ keys: ["id"] })');
    expect(inputOf("renameLabel")).toBe(
      'todoSchema<{ labelId?: string; name: string }>({ keys: ["labelId", "name"] })',
    );
    // a payload type without keys keeps a placeholder without them
    expect(inputOf("ping")).toBe("todoSchema<Record<string, never>>()");
    // and every placeholder input of a payload with an id lists it
    const contracts = [...output]
      .filter(([file]) => file.startsWith("packages/shared/src/contracts/"))
      .map(([, text]) => text)
      .join("\n");
    const inputs = contracts.match(/input: todoSchema<\{ id: [^}]*\}>\([^)]*\)/gu) ?? [];
    expect(inputs).toHaveLength(5);
    for (const input of inputs) {
      expect(input).toContain('keys: ["id"');
    }
  });

  it("makes defineService refuse an id under an open form without rowless, as a real schema does", () => {
    /* oxlint-disable quickdraw/no-todo-schema -- the placeholder is what this tests */
    const keys = JSON.parse(/keys: (\[[^\]]*\])/u.exec(inputOf("getLabelName"))?.[1] ?? "[]");
    expect(keys).toEqual(["id"]);
    const define = (input: StandardSchemaV1, rowless: boolean) => () =>
      defineLoosely(
        defineContract("labelService", {
          entity: todoSchema({ keys: ["id", "projectId", "name"] }),
          methods: { getLabelName: query({ input, output: todoSchema() }) },
        }),
        {
          model: "label",
          access: resolver({ levelsFor: () => ({}) }),
          methods: {
            getLabelName: {
              access: "public",
              ...(rowless ? { rowless } : {}),
              handler: () => null,
            },
          },
        },
      );
    const refusal =
      'method "getLabelName" takes a row id (its input has id), but its access "public"';
    for (const input of [todoSchema({ keys }), z.object({ id: z.string() })]) {
      expect(define(input, false)).toThrow(refusal);
      expect(define(input, true)).not.toThrow();
    }
    // the placeholder without keys hid the id: the check let it through
    expect(define(todoSchema(), false)).not.toThrow();
    /* oxlint-enable quickdraw/no-todo-schema */
  });
});

describe("an inline import() type of a 4.x method map", () => {
  it("names its module from the contract file, in the input and in the output", () => {
    // types/project.ts writes import("./limits.js"), a path from types/
    const line =
      (output.get("packages/shared/src/contracts/project.ts") ?? "")
        .split("\n")
        .find((text) => text.includes("getProjectLimits:")) ?? "";
    expect(line).toContain(
      'input: todoSchema<{ scope?: import("../types/limits.js").LimitsScope }>({ keys: ["scope"] })',
    );
    expect(line).toContain('output: todoSchema<import("../types/limits.js").ProjectLimits>()');
    expect(line).not.toContain('import("./limits.js")');
  });
});

describe("the imports of the files the shared package gets", () => {
  const created = (): [string, string][] =>
    [...output].filter(([file]) => /^packages\/shared\/src\/contracts\/[^/]+\.ts$/u.test(file));

  it("are exactly the names each contract and the helpers file use", () => {
    expect(created().map(([file]) => file.split("/").at(-1))).toEqual([
      ...["health.ts", "helpers.ts", "index.ts", "label.ts", "project.ts", "task.ts", "user.ts"],
    ]);
    for (const [file, text] of created()) {
      const source = new Project({ useInMemoryFileSystem: true }).createSourceFile(file, text);
      const imported = source
        .getImportDeclarations()
        .flatMap((declaration) => [
          declaration.getDefaultImport(),
          declaration.getNamespaceImport(),
          ...declaration
            .getNamedImports()
            .map((specifier) => specifier.getAliasNode() ?? specifier.getNameNode()),
        ])
        .flatMap((name) => (name === undefined ? [] : [name.getText()]));
      const used = new Set(
        source
          .getDescendantsOfKind(SyntaxKind.Identifier)
          .filter(
            (identifier) =>
              identifier.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) === undefined,
          )
          .map((identifier) => identifier.getText()),
      );
      expect(
        imported.filter((name) => !used.has(name)),
        file,
      ).toEqual([]);
      // a builder stays a value import: the contract calls it
      expect(text, file).not.toMatch(/^import type \{[^}]*\} from "@fitzzero\/quickdraw-core";$/mu);
    }
  });

  it("leave out core's nullable beside Zod's .nullable(), and a Zod import only a moved helper needed", () => {
    const task = output.get("packages/shared/src/contracts/task.ts") ?? "";
    expect(task).toContain("assigneeId: z.string().nullable()");
    expect(task).toContain(
      'import { defineContract, listOf, mutation, query, todoSchema } from "@fitzzero/quickdraw-core";',
    );
    // health.ts's only schema is the helper byIdSchema, whose z is helpers.ts's
    const health = output.get("packages/shared/src/contracts/health.ts") ?? "";
    expect(health).toContain("getProjectHealth: query({ input: byIdSchema,");
    expect(health).not.toContain('from "zod"');
    expect(output.get("packages/shared/src/contracts/helpers.ts")).toContain(
      'import { z } from "zod";',
    );
  });
});

describe("moved schemas of one name, and schemas used through an alias", () => {
  const contract = (): string => output.get("packages/shared/src/contracts/task.ts") ?? "";
  const methodLine = (text: string, name: string): string =>
    text.split("\n").find((line) => line.includes(`${name}:`)) ?? "";

  it("writes the same schema of two method modules once, whatever its layout", () => {
    // archive.ts writes it on one line, queries.ts on three with a trailing comma
    expect(contract().match(/^const projectIdSchema = /gmu)).toHaveLength(1);
    expect(methodLine(contract(), "listArchivedTasks")).toContain("input: projectIdSchema,");
    expect(methodLine(contract(), "listTasks")).toContain("input: projectIdSchema,");
    // the api copies go, with the comment above one
    for (const file of ["archive.ts", "queries.ts"]) {
      expect(output.get(`apps/api/src/services/task/methods/${file}`)).not.toContain(
        "projectIdSchema",
      );
    }
    expect(output.get("apps/api/src/services/task/methods/queries.ts")).not.toContain(
      "laid out differently",
    );
  });

  it("renames another schema of the name as <name>Of<Module>, where it is declared and used", () => {
    expect(contract()).toContain(
      'const byTaskIdSchemaOfUpdateTask = z.object({ id: cuidSchema("task ID") });',
    );
    expect(contract()).toContain("const updateTaskSchema = byTaskIdSchemaOfUpdateTask.extend({");
    expect(methodLine(contract(), "archiveTask")).toContain("input: byTaskIdSchema,");
    expect(contract()).toContain(
      "its schema's byTaskIdSchema (apps/api/src/services/task/methods/update-task.ts) is byTaskIdSchemaOfUpdateTask here, since the contract has another byTaskIdSchema",
    );
    // the api copy goes once the schema that used it is gone
    expect(output.get("apps/api/src/services/task/methods/update-task.ts")).not.toContain(
      "byTaskIdSchema",
    );
  });

  it("writes a schema used through a re-export alias by its declared name", () => {
    // project.ts passes deleteProjectSchema, project-schemas.ts's alias of byIdSchema
    const project = output.get("packages/shared/src/contracts/project.ts") ?? "";
    expect(methodLine(project, "deleteProject")).toContain(
      "deleteProject: mutation({ input: byIdSchema,",
    );
    expect(project).not.toContain("deleteProjectSchema");
  });

  it("keeps apart copies of the same text that name different declarations", () => {
    const variant = copyFixture("same-text");
    const edit = (file: string, from: string, to: string): void => {
      const path = join(variant, "apps/api/src/services/task/methods", file);
      const text = readFileSync(path, "utf8");
      expect(text, file).toContain(from);
      writeFileSync(path, text.replace(from, to));
    };
    edit(
      "archive.ts",
      "const projectIdSchema = z.object({ projectId: z.string() });",
      "const idField = z.string().min(1);\nconst projectIdSchema = z.object({ projectId: idField });",
    );
    edit(
      "queries.ts",
      "const projectIdSchema = z.object({\n  projectId: z.string(),\n});",
      "const idField = z.string().cuid();\nconst projectIdSchema = z.object({ projectId: idField });",
    );
    const run = runCodemod({ root: variant });
    const text = readFileSync(join(variant, "packages/shared/src/contracts/task.ts"), "utf8");
    expect(text).toContain("const idField = z.string().min(1);");
    expect(text).toContain("const projectIdSchema = z.object({ projectId: idField });");
    expect(text).toContain("const idFieldOfQueries = z.string().cuid();");
    expect(text).toContain(
      "const projectIdSchemaOfQueries = z.object({ projectId: idFieldOfQueries });",
    );
    expect(methodLine(text, "listArchivedTasks")).toContain("input: projectIdSchema,");
    expect(methodLine(text, "listTasks")).toContain("input: projectIdSchemaOfQueries,");
    expect({ merged: run.stats.schemasMerged, renamed: run.stats.schemasRenamed }).toEqual({
      merged: 0,
      renamed: 3,
    });
  });
});

/** How often `pattern` matches in the fixture's api sources. */
function countInFixture(pattern: RegExp): number {
  let count = 0;
  for (const [file, text] of readTree(FIXTURE)) {
    if (file.startsWith("apps/api/src/services/")) {
      count += text.match(pattern)?.length ?? 0;
    }
  }
  return count;
}

describe("the report", () => {
  const items = (): ReturnType<typeof findMarkers> =>
    [...output].flatMap(([file, text]) => findMarkers(text, file));
  const section = (title: string): string[] => {
    const text = output.get(REPORT_FILE) ?? "";
    const start = text.indexOf(`## ${title}\n`);
    const end = text.indexOf("\n## ", start + 1);
    return text
      .slice(start, end === -1 ? undefined : end)
      .split("\n")
      .filter((line) => line.startsWith("- [ ] "));
  };
  /** The line below the item's marker: the code it is about. */
  const codeAt = (line: string): string => {
    const [, file = "", number = "0"] = /`([^`:]+):(\d+)`/u.exec(line) ?? [];
    const lines = (output.get(file) ?? "").split("\n");
    let next = Number(number);
    while ((lines[next] ?? "").includes(MARKER)) {
      next += 1;
    }
    return lines.slice(next, next + 3).join("\n");
  };

  it("is written at the repository root, and lists every marker in the code, at its file and line", () => {
    expect(readFileSync(join(root, REPORT_FILE), "utf8")).toBe(result.report);
    const listed = (output.get(REPORT_FILE) ?? "")
      .split("\n")
      .filter((line) => line.startsWith("- [ ] "));
    expect(listed.map((line) => /`([^`]+)`/u.exec(line)?.[1]).toSorted()).toEqual(
      items()
        .map((item) => `${item.file}:${String(item.line)}`)
        .toSorted(),
    );
    expect(result.items).toBe(items().length);
  });

  it("lists every hand emit of the fixture", () => {
    const emits = countInFixture(
      /\.(?:emitUpdate|emitCollection\w+|notifyCollections|emitToRoom\w*|kickFromCollection)\(/gu,
    );
    const listed = section("Hand emits to delete");
    expect(listed).toHaveLength(emits);
    for (const line of listed) {
      expect(codeAt(line)).toMatch(/\.(?:emit|notify|kick)\w*\(/u);
    }
  });

  it("lists every this.create, this.update and this.delete", () => {
    const listed = section("this.create, this.update and this.delete to write through db");
    // label.ts's removeLabel calls the class's own delete override, not 4.x's helper
    const overrideCalls = countInFixture(/return await this\.delete\(id\);/gu);
    expect(listed).toHaveLength(
      countInFixture(/this\.(?:create|update|delete)\(/gu) - overrideCalls,
    );
    for (const line of listed) {
      expect(codeAt(line)).toMatch(/this\.(?:create|update|delete)\(/u);
    }
  });

  it("lists every access override, toDto and protected fields, collection, lifecycle hook and installAdminMethods", () => {
    const overrides = countInFixture(/override (?:async )?(?:checkAccess|checkEntryACL)\(/gu);
    const placeholders = 2;
    expect(section("Access overrides to turn into a policy")).toHaveLength(
      overrides + placeholders,
    );
    expect(section("toDto and protected fields to turn into projections and fields")).toHaveLength(
      countInFixture(/override (?:async )?(?:toDto|getProtectedFields)\(/gu),
    );
    expect(section("Collections to declare in contracts")).toHaveLength(
      countInFixture(/this\.defineCollection\(/gu),
    );
    expect(section("Lifecycle hooks")).toHaveLength(
      countInFixture(/override async (?:before|after)(?:Create|Update|Delete)\(/gu),
    );
    expect(section("installAdminMethods to replace with the admin kit")).toHaveLength(
      countInFixture(/this\.installAdminMethods\(/gu),
    );
    for (const line of section("Collections to declare in contracts")) {
      expect(codeAt(line)).toMatch(/^const \w+Collection = \{/u);
    }
  });

  it("lists a contract item for every migrated method and entity", () => {
    // and one above each handler whose 4.x DTO | null output became "entity"
    const nonNull = section("Contracts").filter((line) =>
      line.includes('the contract\'s output is "entity"'),
    );
    expect(nonNull.map((line) => /`([^`:]+):/u.exec(line)?.[1])).toEqual([
      "apps/api/src/services/project.ts",
      "apps/api/src/services/task/methods/update-task.ts",
    ]);
    expect(section("Contracts")).toHaveLength(result.stats.methods + 4 + nonNull.length);
  });

  it("keeps a carve-out's markers around an entity key the DTO declares inside it", () => {
    expect(output.get("packages/shared/src/contracts/project.ts")).toMatch(
      /keys: \[\n\s+"id",\n\s+"name",\n\s+"ownerId",\n\s+"acl",\n\s+\/\/ ── quickdraw-archive:start ──\n\s+"archived",\n\s+\/\/ ── quickdraw-archive:end ──\n\s+\]/u,
    );
  });

  it("lists each new file of a carve-out", () => {
    expect(section("Carve-outs")).toEqual([
      expect.stringMatching(
        /^- \[ \] `packages\/shared\/src\/contracts\/label\.ts:5` this file belongs to the quickdraw-labels carve-out/u,
      ),
    ]);
  });

  it("lists every method of a kit method's shape, marked above the method", () => {
    const listed = section("Methods a kit implements");
    expect(
      listed.map((line) => /^- \[ \] `[^`]+` (\w+) has the shape of/u.exec(line)?.[1]),
    ).toEqual([
      ...["getLabel", "listLabels", "createProject", "getProject", "deleteProject"],
      ...["createTask", "listTasks", "updateTask", "updateUser"],
    ]);
    for (const line of listed) {
      const name = /^- \[ \] `[^`]+` (\w+)/u.exec(line)?.[1] ?? "";
      expect(codeAt(line)).toMatch(new RegExp(`^\\s*${name}[:,]`, "u"));
    }
  });
});

describe("the kit shapes", () => {
  it("are the ones lint's prefer-kit reports", () => {
    const names = [
      ...["get", "getMany", "list", "create", "update", "delete", "reorder", "bulkUpdate"],
      ...["bulkDelete", "search", "share", "shareByName", "unshare", "listShares", "invite"],
      ...["inviteByName", "remove", "listMembers", "leave", "setRole", "setLevel"],
      ...["adminList", "adminGet", "adminCreate", "adminUpdate", "adminDelete", "adminMeta"],
      ...["getTask", "listTasks", "createTask", "updateTask", "deleteTask", "removeTask"],
      ...["getProject", "listCategories", "deleteCategory", "updateProjectMember"],
      ...["listAddresses", "listTaskes", "getCategory", "rename", "getMe", "find"],
    ];
    const models = ["task", "category", "address", "projectMember", "membership", undefined];
    const siblings = [[], ["rename", "leave"], ["share"], ["invite"], ["listMembers"]];
    for (const model of models) {
      for (const methods of siblings) {
        for (const name of names) {
          const lint = model === undefined ? undefined : preferKit(name, model, methods);
          const label = `${name} on ${String(model)} beside ${methods.join(", ")}`;
          expect(kitShapeOf(name, model, methods)?.method, label).toBe(lint?.method);
        }
      }
    }
    expect(kitShapeOf("remove", "task")).toBeUndefined();
    expect(kitShapeOf("remove", "task", ["invite"])?.method).toBe("remove");
    expect(kitShapeOf("remove", "projectMember")?.method).toBe("remove");
    expect(kitShapeOf("deleteTask", "task")?.method).toBe("delete");
  });
});

describe("the module-level name of a hoisted member", () => {
  it("is the member's own name, unless it is taken, a reserved word or no identifier", () => {
    const taken = new Set(["db", "room"]);
    expect(moduleName("roomStats", "LabelService", taken)).toBe("roomStats");
    expect(moduleName("room", "LabelService", taken)).toBe("roomOfLabelService");
    expect(moduleName("delete", "TaskService", taken)).toBe("deleteOfTaskService");
    expect(moduleName("new", "TaskService", taken)).toBe("newOfTaskService");
    expect(moduleName("class", "TaskService", taken)).toBe("classOfTaskService");
    expect(moduleName('"by-name"', "TaskService", taken)).toBe("byNameOfTaskService");
    expect(moduleName('"2fa"', "TaskService", taken)).toBe("member2faOfTaskService");
  });
});

describe("a 4.x instance's members outside the services", () => {
  it("are found in every file when a declare global gives a file without imports the class's type", () => {
    // Only files that import a class's file, directly or through others, are
    // asked for types; a global declared in one of them reaches every file.
    const copy = copyFixture("globals");
    writeFileSync(
      join(copy, "apps/api/src/globals.ts"),
      [
        `import type { LabelService } from "./services/label.js";`,
        ``,
        `declare global {`,
        `  var labels: LabelService;`,
        `}`,
        ``,
        `export {};`,
        ``,
      ].join("\n"),
    );
    writeFileSync(
      join(copy, "apps/web/src/components/GlobalLabels.tsx"),
      [
        `export function GlobalLabels({ projectId }: { projectId: string }) {`,
        `  return <p>{labels.getRoomName(projectId)}</p>;`,
        `}`,
        ``,
      ].join("\n"),
    );
    runCodemod({ root: copy });
    expect(readFileSync(join(copy, "apps/web/src/components/GlobalLabels.tsx"), "utf8")).toContain(
      `${MARKER} [client] labels is a 4.x LabelService instance, whose members (getRoomName here)`,
    );
  });
});
