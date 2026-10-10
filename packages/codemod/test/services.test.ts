// Which class each service is read from: never one in test code, one per
// service name, and the same one whatever order the files come in. The
// projects here live in memory; the fixture app's run is transforms.test.ts.

import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";
import { createContext } from "../src/context";
import type { Layout } from "../src/layout";
import { findServices } from "../src/model";
import { planService } from "../src/plan";
import { writeContracts } from "../src/transforms";
import { isTestFile } from "../src/project";

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
  createTask: { payload: { title: string }; response: { id: string } };
  listTasks: { payload: Record<string, never>; response: { id: string }[] };
}
`;

const CORE = `
import { BaseRpcService } from "@fitzzero/quickdraw-core/server";
import type { TaskServiceMethods } from "@project/shared";

export abstract class TaskServiceCore extends BaseRpcService<TaskServiceMethods> {
  constructor() {
    super({ serviceName: "taskService" });
  }
}
`;

const MODULE = `
import type { TaskService } from "../index";

export function registerTaskMethods(service: TaskService): void {
  service.defineMethod("createTask", "Read", async () => ({ id: "t" }));
  service.defineMethod("listTasks", "Read", async () => []);
}
`;

const SERVICE = `
import { TaskServiceCore } from "./service-core";
import { registerTaskMethods } from "./methods/tasks";

export class TaskService extends TaskServiceCore {
  constructor() {
    super();
    registerTaskMethods(this);
  }
}
`;

/** A test's subclass of the abstract core: it sees none of the method modules. */
const TEST_SUBCLASS = `
import { TaskServiceCore } from "../service-core";

export class TestTaskService extends TaskServiceCore {}
`;

/** A test's subclass of the real service. */
const QUIET_SUBCLASS = `
import { TaskService } from "../../task/index";

export class QuietTaskService extends TaskService {}
`;

const PROBE = `
import { BaseRpcService } from "@fitzzero/quickdraw-core/server";

export class ProbeService extends BaseRpcService<{ probe: { payload: null; response: null } }> {
  constructor() {
    super({ serviceName: "probeService" });
    this.defineMethod("probe", "Public", async () => null);
  }
}
`;

/** A project of `files` (paths under the api's src), added in the order given. */
function projectOf(files: Record<string, string>): Project {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { strict: true, paths: { "@project/shared": [`${SHARED}/index.ts`] } },
  });
  project.createSourceFile(`${SHARED}/index.ts`, SHARED_TYPES);
  for (const [path, text] of Object.entries(files)) {
    project.createSourceFile(`${API}/${path}`, text);
  }
  return project;
}

const TASK = {
  "services/task/service-core.ts": CORE,
  "services/task/methods/tasks.ts": MODULE,
  "services/task/index.ts": SERVICE,
};
const TESTS = {
  "services/task/__tests__/delta.test.ts": TEST_SUBCLASS,
  "services/audit/__tests__/quiet.test.ts": QUIET_SUBCLASS,
  "__tests__/utils/probe-service.ts": PROBE,
};

describe("isTestFile", () => {
  it("is true under __tests__ or testing, and for *.test and *.spec files", () => {
    for (const path of [
      "apps/api/src/__tests__/utils/probe-service.ts",
      "apps/api/src/services/task/__tests__/delta.ts",
      "apps/api/src/testing/fixtures.ts",
      "apps/api/src/services/task.test.ts",
      "apps/web/src/Board.test.tsx",
      "apps/api/src/services/task.spec.ts",
    ]) {
      expect(isTestFile(path), path).toBe(true);
    }
  });

  it("is false for the rest", () => {
    for (const path of [
      "apps/api/src/services/task/index.ts",
      "apps/api/src/services/testing.ts",
      "apps/api/src/services/contest/index.ts",
      "packages/db/src/testing.ts",
    ]) {
      expect(isTestFile(path), path).toBe(false);
    }
  });
});

describe("findServices", () => {
  it("reads a service from its real class, whatever order the test files come in", () => {
    for (const files of [
      { ...TESTS, ...TASK },
      { ...TASK, ...TESTS },
    ]) {
      const services = findServices(projectOf(files), LAYOUT);
      expect(services.map((service) => [service.serviceName, service.className])).toEqual([
        ["taskService", "TaskService"],
      ]);
      expect(services[0]?.methods.map((method) => method.name)).toEqual([
        "createTask",
        "listTasks",
      ]);
      expect(services[0]?.shadowed).toEqual([]);
    }
  });

  it("reads one class per service name: the one registerService instantiates", () => {
    const legacy = `
import { TaskServiceCore } from "./service-core";

export class LegacyTaskService extends TaskServiceCore {}
`;
    const server = `
import { LegacyTaskService } from "./services/task/legacy";

declare const registry: { registerService(name: string, service: unknown): void };
const tasks = new LegacyTaskService();
registry.registerService("taskService", tasks);
`;
    for (const order of ["before", "after"]) {
      const files = {
        ...(order === "before" ? { "index.ts": server } : {}),
        ...TASK,
        "services/task/legacy.ts": legacy,
        ...(order === "after" ? { "index.ts": server } : {}),
      };
      const [service, ...rest] = findServices(projectOf(files), LAYOUT);
      expect(rest).toEqual([]);
      expect(service?.className).toBe("LegacyTaskService");
      expect(service?.shadowed.map((cls) => cls.getName())).toEqual(["TaskService"]);
    }
  });

  it("without a registerService call, reads the class named after the service", () => {
    const other = `
import { TaskServiceCore } from "./service-core";

export class AaaTaskService extends TaskServiceCore {}
`;
    const [service] = findServices(projectOf({ "services/task/aaa.ts": other, ...TASK }), LAYOUT);
    expect(service?.className).toBe("TaskService");
    expect(service?.shadowed.map((cls) => cls.getName())).toEqual(["AaaTaskService"]);
  });
});

describe("a service whose class implements none of its method map", () => {
  it("is reported on stderr, naming the class read, and marked in its contract", () => {
    const lone = `
import { TaskServiceCore } from "./service-core";

export class TaskService extends TaskServiceCore {}
`;
    const project = projectOf({
      "services/task/service-core.ts": CORE,
      "services/task/index.ts": lone,
    });
    const ctx = createContext(project, LAYOUT);
    const [service] = findServices(project, LAYOUT);
    if (service === undefined) {
      throw new Error("no service");
    }
    const plan = planService(ctx, service);
    expect(plan.methods).toEqual([]);
    expect(plan.unimplemented).toEqual(["createTask", "listTasks"]);
    writeContracts(ctx, [plan]);
    expect(ctx.warnings).toEqual([
      "taskService: read from TaskService (apps/api/src/services/task/index.ts), which implements none of the 2 methods of TaskServiceMethods: its contract has no methods",
    ]);
    const contract = project.getSourceFileOrThrow(plan.contractFile).getFullText();
    expect(contract).toContain(
      "// quickdraw-migrate: review [service] TaskService implements none of the methods its 4.x method map names",
    );
  });
});
