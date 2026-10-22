// Method objects beside bindings of their methods' names, on projects in
// memory (the fixture app's run is transforms.test.ts): `renameEdits`
// rewrites every form a binding is used in and nothing another scope binds,
// a class member hoisted beside a method object of its name takes another,
// a register function named after its method is no clash (the run replaces
// it), a handler's local of the method's name is renamed like any binding
// that would shadow the object, and an import the module re-exports keeps
// its name while the object takes `<name>Method`. Hoisted members get the
// same care: a binding below module scope where a member lands (a module
// function's parameter beside the member's import, a handler's local of the
// member it reads through the service) is renamed, the member keeping its
// name.

import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";
import { moduleBindings, nestedBindings, renameEdits } from "../src/bindings";
import { createContext } from "../src/context";
import type { Layout } from "../src/layout";
import { migrate } from "../src/migrate";
import { applyEdits } from "../src/text";

/** `text` with the binding of `name` that `pick` chooses renamed `to`, everywhere it is used. */
function renamed(
  text: string,
  name: string,
  to: string,
  pick: "module" | "nested" = "module",
): string {
  const file = new Project({ useInMemoryFileSystem: true }).createSourceFile("/m.ts", text);
  const [binding] =
    pick === "module" ? moduleBindings(file, name) : (nestedBindings(file).get(name) ?? []);
  if (binding === undefined) {
    throw new Error(`no binding of ${name}`);
  }
  return applyEdits(file.getFullText(), 0, renameEdits(binding, to));
}

describe("renameEdits", () => {
  it("renames an import where it is used, keeping the imported and exported names", () => {
    const text = [
      'import { rename } from "./impl";',
      "export { rename };",
      "export const calls = { rename, result: rename(), kind: typeof rename };",
      "export type Rename = typeof rename;",
      "export function own(rename: string): string {",
      "  return rename;",
      "}",
      "const { rename: picked } = { rename: calls.rename };",
      "export const again = picked;",
      "",
    ].join("\n");
    expect(renamed(text, "rename", "renameImpl")).toBe(
      [
        'import { rename as renameImpl } from "./impl";',
        "export { renameImpl as rename };",
        "export const calls = { rename: renameImpl, result: renameImpl(), kind: typeof renameImpl };",
        "export type Rename = typeof renameImpl;",
        "export function own(rename: string): string {",
        "  return rename;",
        "}",
        "const { rename: picked } = { rename: calls.rename };",
        "export const again = picked;",
        "",
      ].join("\n"),
    );
  });

  it("renames default and namespace imports, and destructured names, keeping their keys", () => {
    expect(renamed('import load from "./impl";\nload();\n', "load", "loadImpl")).toBe(
      'import loadImpl from "./impl";\nloadImpl();\n',
    );
    expect(renamed('import * as all from "./impl";\nall.go();\n', "all", "allImpl")).toBe(
      'import * as allImpl from "./impl";\nallImpl.go();\n',
    );
    const destructured = "const { go = 1, ...rest } = source;\nconst [first] = list;\n";
    expect(renamed(destructured, "go", "goBody")).toContain("const { go: goBody = 1, ...rest }");
    expect(renamed(destructured, "rest", "restBody")).toContain("...restBody }");
    expect(renamed(destructured, "first", "firstBody")).toContain("const [firstBody] = list;");
  });

  it("finds the bindings below module scope that would shadow one, but not a signature's parameters", () => {
    const text = [
      'import { count } from "./impl";',
      "export function a(): number {",
      "  const count = 1;",
      "  return count;",
      "}",
      "export const b = ({ count }: { count: number }): number => count;",
      "export type F = (count: number) => void;",
      "export declare function c(count: number): void;",
      "",
    ].join("\n");
    const file = new Project({ useInMemoryFileSystem: true }).createSourceFile("/m.ts", text);
    expect(
      nestedBindings(file)
        .get("count")
        ?.map((binding) => binding.getStartLineNumber()),
    ).toEqual([3, 6]);
    expect(renamed(text, "count", "countImpl", "nested")).toContain(
      "  const countImpl = 1;\n  return countImpl;\n",
    );
  });
});

const ROOT = "/app";
const API = `${ROOT}/apps/api/src`;
const SHARED = `${ROOT}/packages/shared/src`;

const LAYOUT: Layout = {
  root: ROOT,
  shared: { dir: `${ROOT}/packages/shared`, src: SHARED, name: "@project/shared" },
  api: { dir: `${ROOT}/apps/api`, src: API, name: "api" },
  web: undefined,
  others: [],
  dbPackage: "@project/db",
};

const SHARED_TYPES = `
export interface TaskServiceMethods {
  countTasks: { payload: { projectId: string }; response: { count: number } };
  ping: { payload: Record<string, never>; response: { ok: boolean } };
  renameTask: { payload: { id: string; title: string }; response: { id: string } };
}
`;

/** A split service whose files bind its method objects' names in the ways a run frees. */
const SERVICE = {
  "services/task/service-core.ts": `
import { BaseRpcService } from "@fitzzero/quickdraw-core/server";
import type { TaskServiceMethods } from "@project/shared";

export abstract class TaskServiceCore extends BaseRpcService<TaskServiceMethods> {
  constructor() {
    super({ serviceName: "taskService" });
  }

  // a helper of a module method's name
  public async countTasks(projectId: string): Promise<number> {
    return projectId.length;
  }
}
`,
  "services/task/rows.ts": `
export async function renameTask(id: string, title: string): Promise<string> {
  return \`\${id}:\${title}\`;
}
`,
  "services/task/methods/count.ts": `
import type { TaskService } from "../index";

export function registerCount(service: TaskService): void {
  service.defineMethod("countTasks", "Read", async (payload) => {
    const countTasks = await service.countTasks(payload.projectId);
    return { count: countTasks };
  });
}
`,
  "services/task/methods/ping.ts": `
import type { TaskService } from "../index";

export function ping(service: TaskService): void {
  service.defineMethod("ping", "Public", async () => ({ ok: true }));
}
`,
  "services/task/methods/rename.ts": `
import type { TaskService } from "../index";
import { renameTask } from "../rows";

export { renameTask };

export function registerRename(service: TaskService): void {
  service.defineMethod("renameTask", "Moderate", async (payload) => ({
    id: await renameTask(payload.id, payload.title),
  }));
}
`,
  "services/task/index.ts": `
import { TaskServiceCore } from "./service-core";
import { registerCount } from "./methods/count";
import { ping } from "./methods/ping";
import { registerRename } from "./methods/rename";

export class TaskService extends TaskServiceCore {
  constructor() {
    super();
    registerCount(this);
    ping(this);
    registerRename(this);
  }

  public async total(projectId: string): Promise<number> {
    return await this.countTasks(projectId);
  }
}
`,
};

/** A project of the shared types and `files` (paths under the api's src), migrated in memory. */
function migrated(files: Record<string, string>): Project {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { strict: true, paths: { "@project/shared": [`${SHARED}/index.ts`] } },
  });
  project.createSourceFile(`${SHARED}/index.ts`, SHARED_TYPES);
  for (const [path, text] of Object.entries(files)) {
    project.createSourceFile(`${API}/${path}`, text);
  }
  migrate(createContext(project, LAYOUT));
  return project;
}

describe("a split service whose files bind its method objects' names", () => {
  const project = migrated(SERVICE);
  const text = (path: string): string =>
    project.getSourceFileOrThrow(`${API}/services/task/${path}`).getFullText();

  it("declares each name once in a scope", () => {
    const clashes = project
      .getPreEmitDiagnostics()
      .filter((diagnostic) => [2300, 2440, 2451].includes(diagnostic.getCode()));
    expect(clashes.map((diagnostic) => diagnostic.getMessageText())).toEqual([]);
  });

  it("hoists a class member of a module method's name as <name>Of<Class>, wherever it is called", () => {
    expect(text("service-core.ts")).toContain(
      "export async function countTasksOfTaskServiceCore(projectId: string): Promise<number> {",
    );
    expect(text("methods/count.ts")).toContain(
      'import { countTasksOfTaskServiceCore } from "../service-core";',
    );
    expect(text("index.ts")).toContain("return await countTasksOfTaskServiceCore(projectId);");
    expect(text("methods/count.ts")).toMatch(/^export const countTasks = \{$/mu);
  });

  it("renames a handler's local of its method's name, which would shadow the method object", () => {
    expect(text("methods/count.ts")).toContain(
      "const countTasksImpl = await countTasksOfTaskServiceCore(input.projectId);\n    return { count: countTasksImpl };",
    );
  });

  it("gives a register function's name to the method object that replaces it", () => {
    expect(text("methods/ping.ts")).toMatch(/^export const ping = \{$/mu);
    expect(text("index.ts")).toContain('import { ping } from "./methods/ping";');
  });

  it("keeps an import the module re-exports, and names the method object <name>Method", () => {
    const rename = text("methods/rename.ts");
    expect(rename).toContain('import { renameTask } from "../rows";');
    expect(rename).toContain("export { renameTask };");
    expect(rename).toMatch(/^export const renameTaskMethod = \{$/mu);
    expect(rename).toContain("id: await renameTask(input.id, input.title),");
    expect(text("index.ts")).toContain('import { renameTaskMethod } from "./methods/rename";');
    expect(text("index.ts")).toMatch(/^ {4}renameTask: renameTaskMethod,$/mu);
  });
});

/** A split service whose files outside its classes bind the name of a field its code reads. */
const MEMBERS = {
  "services/task/service-core.ts": `
import { BaseRpcService } from "@fitzzero/quickdraw-core/server";
import type { TaskServiceMethods } from "@project/shared";

export abstract class TaskServiceCore extends BaseRpcService<TaskServiceMethods> {
  public limit = 100;

  constructor() {
    super({ serviceName: "taskService" });
  }
}
`,
  "services/task/methods/count.ts": `
import type { TaskService } from "../index";

export function registerCount(service: TaskService): void {
  service.defineMethod("countTasks", "Read", async (payload) => {
    const limit = service.limit;
    return { count: Math.min(payload.projectId.length, limit) };
  });
}
`,
  "services/task/index.ts": `
import { TaskServiceCore } from "./service-core";
import { registerCount } from "./methods/count";

export class TaskService extends TaskServiceCore {
  constructor() {
    super();
    registerCount(this);
  }

  public underLimit(count: number): boolean {
    return count < this.limit;
  }
}

export function clamp(count: number, limit: number): number {
  return Math.min(count, limit);
}
`,
};

describe("a hoisted field whose name code outside its class binds below module scope", () => {
  const project = migrated(MEMBERS);
  const text = (path: string): string =>
    project.getSourceFileOrThrow(`${API}/services/task/${path}`).getFullText();

  it("keeps its name, and nothing is declared twice or read before it is", () => {
    expect(text("service-core.ts")).toMatch(/^export const limit = 100;$/mu);
    const clashes = project
      .getPreEmitDiagnostics()
      .filter((diagnostic) => [2300, 2440, 2448, 2451].includes(diagnostic.getCode()));
    expect(clashes.map((diagnostic) => diagnostic.getMessageText())).toEqual([]);
  });

  it("renames a parameter of a module function beside its import <name>Impl (Conveyor's reviewCatchUp)", () => {
    expect(text("index.ts")).toContain('import { limit } from "./service-core";');
    expect(text("index.ts")).toContain("return count < limit;");
    expect(text("index.ts")).toContain(
      "export function clamp(count: number, limitImpl: number): number {\n  return Math.min(count, limitImpl);",
    );
  });

  it("renames a handler's local that would capture what it read through the service", () => {
    expect(text("methods/count.ts")).toContain(
      "const limitImpl = limit;\n    return { count: Math.min(input.projectId.length, limitImpl) };",
    );
  });
});
