import { describe, expect, it, vi } from "vitest";
import type { AccessLevel } from "../../index";
import { alice, project, qd, task, taskDefaults } from "../__tests__/fixtures";
import { createContext, NEVER_ABORTED, type AnyContext } from "../context";
import type { Principal } from "../types";
import { createBasicAccessEngine } from "./basicEngine";
import { accessIds, accessFormProblem, custom } from "./forms";
import { meetsLevel, serviceGrant } from "./levels";
import type { AccessForm, AccessRequest, RowAccess } from "./types";

const service = qd.defineService(task, { methods: taskDefaults });
const strictService = qd.defineService(task, { methods: taskDefaults, adminBypass: false });

function contextOf(principal: Principal | null): AnyContext {
  return createContext({
    principal,
    signal: NEVER_ABORTED,
    log: { debug() {}, info() {}, warn() {}, error() {}, child: () => contextOf(null).log },
    requestId: "r1",
    transport: "internal",
  });
}

function request(
  principal: Principal | null,
  overrides: Partial<AccessRequest> = {},
): AccessRequest {
  return {
    service,
    method: "count",
    principal,
    input: { projectId: "p1" },
    ctx: contextOf(principal),
    ...overrides,
  };
}

function withGrant(level: AccessLevel | undefined): Principal {
  return level === undefined ? alice : { ...alice, serviceAccess: { taskService: level } };
}

async function outcome(
  form: AccessForm,
  principal: Principal | null,
  options: { rows?: RowAccess; overrides?: Partial<AccessRequest> } = {},
): Promise<string> {
  const engine = createBasicAccessEngine(options.rows === undefined ? {} : { rows: options.rows });
  try {
    await engine.authorize(form, request(principal, options.overrides));
    return "ok";
  } catch (error) {
    return (error as { code: string }).code;
  }
}

describe("createBasicAccessEngine", () => {
  it('lets anyone through "public", and any principal through "authenticated"', async () => {
    expect(await outcome("public", null)).toBe("ok");
    expect(await outcome("authenticated", null)).toBe("UNAUTHENTICATED");
    expect(await outcome("authenticated", alice)).toBe("ok");
  });

  it("compares the service grant with { service }", async () => {
    const form = { service: "Moderate" } as const;
    expect(await outcome(form, null)).toBe("UNAUTHENTICATED");
    expect(await outcome(form, withGrant(undefined))).toBe("FORBIDDEN");
    expect(await outcome(form, { ...alice, serviceAccess: null })).toBe("FORBIDDEN");
    expect(await outcome(form, withGrant("Read"))).toBe("FORBIDDEN");
    expect(await outcome(form, withGrant("Moderate"))).toBe("ok");
    expect(await outcome(form, withGrant("Admin"))).toBe("ok");
    expect(await outcome(form, { ...alice, serviceAccess: { projectService: "Admin" } })).toBe(
      "FORBIDDEN",
    );
    expect(await outcome({ service: "Public" }, withGrant(undefined))).toBe("FORBIDDEN");
  });

  it("passes custom(fn) only when fn resolves true, after requiring a principal", async () => {
    const check = vi.fn((_ctx: unknown, input: { projectId: string }) => input.projectId === "p1");
    expect(await outcome(custom(check), null)).toBe("UNAUTHENTICATED");
    expect(check).not.toHaveBeenCalled();
    expect(await outcome(custom(check), alice)).toBe("ok");
    expect(check.mock.calls[0]?.[0]).toMatchObject({ principal: alice, requestId: "r1" });
    expect(await outcome(custom(check), alice, { overrides: { input: { projectId: "p2" } } })).toBe(
      "FORBIDDEN",
    );
    expect(
      await outcome(
        custom(() => Promise.resolve(true)),
        alice,
      ),
    ).toBe("ok");
    expect(
      await outcome(
        custom(() => "yes" as unknown as boolean),
        alice,
      ),
    ).toBe("FORBIDDEN");
    await expect(
      createBasicAccessEngine().authorize(
        custom(() => {
          throw new Error("lookup failed");
        }),
        request(alice),
      ),
    ).rejects.toThrow("lookup failed");
  });

  it("asks rows for entry and scope forms, and fails with INTERNAL when there is no policy", async () => {
    const entry = { entry: "Moderate" } as const;
    const scope = { scope: "Read", of: project, id: "projectId" } as const;
    await expect(createBasicAccessEngine().authorize(entry, request(alice))).rejects.toMatchObject({
      code: "INTERNAL",
      message:
        "taskService.count uses entry access, but no access policy is configured for taskService",
    });
    await expect(createBasicAccessEngine().authorize(scope, request(alice))).rejects.toThrow(
      "taskService.count uses scope access",
    );
    const allows = vi.fn((form: { readonly entry?: unknown }) => form.entry === "Moderate");
    const rows: RowAccess = { allows };
    expect(await outcome(entry, alice, { rows })).toBe("ok");
    expect(await outcome(scope, alice, { rows })).toBe("FORBIDDEN");
    expect(await outcome(entry, null, { rows })).toBe("UNAUTHENTICATED");
    expect(allows).toHaveBeenCalledTimes(2);
  });

  it("passes { service, entry } on either check, and counts a lower grant only where service is named", async () => {
    const rows: RowAccess = { allows: () => false };
    expect(await outcome({ service: "Read", entry: "Moderate" }, withGrant("Read"), { rows })).toBe(
      "ok",
    );
    expect(await outcome({ entry: "Read" }, withGrant("Read"), { rows })).toBe("FORBIDDEN");
    expect(await outcome({ entry: "Read" }, withGrant("Moderate"), { rows })).toBe("FORBIDDEN");
  });

  it("lets a service Admin through every check, unless the service turns adminBypass off", async () => {
    const admin = withGrant("Admin");
    const deny = custom(() => false);
    expect(await outcome(deny, admin)).toBe("ok");
    expect(await outcome({ entry: "Admin" }, admin)).toBe("ok");
    expect(await outcome({ scope: "Admin", of: project, id: "projectId" }, admin)).toBe("ok");
    expect(await outcome(deny, admin, { overrides: { service: strictService } })).toBe("FORBIDDEN");
    expect(
      await outcome({ service: "Admin" }, admin, { overrides: { service: strictService } }),
    ).toBe("ok");
    expect(await outcome({ entry: "Read" }, admin, { overrides: { service: strictService } })).toBe(
      "INTERNAL",
    );
  });
});

describe("access levels", () => {
  it("orders Public < Read < Moderate < Admin, and a missing grant meets nothing", () => {
    expect(meetsLevel("Admin", "Moderate")).toBe(true);
    expect(meetsLevel("Read", "Read")).toBe(true);
    expect(meetsLevel("Read", "Moderate")).toBe(false);
    expect(meetsLevel("Public", "Public")).toBe(true);
    expect(meetsLevel(undefined, "Public")).toBe(false);
    expect(meetsLevel(null, "Public")).toBe(false);
    expect(meetsLevel("Owner" as AccessLevel, "Public")).toBe(false);
  });

  it("reads a principal's own grants only", () => {
    expect(serviceGrant({ ...alice, serviceAccess: { taskService: "Read" } }, "taskService")).toBe(
      "Read",
    );
    expect(serviceGrant({ ...alice, serviceAccess: {} }, "constructor")).toBeUndefined();
    expect(serviceGrant(alice, "taskService")).toBeUndefined();
  });
});

describe("access forms", () => {
  it("names what is wrong with a malformed form", () => {
    expect(accessFormProblem("public")).toBeUndefined();
    expect(
      accessFormProblem({ entry: "Read", id: (input: unknown) => String(input) }),
    ).toBeUndefined();
    expect(accessFormProblem(null)).toMatch(/^must be "public"/);
    expect(accessFormProblem({ scope: "Read", of: project })).toMatch(/scope form/);
    expect(() => custom("allow" as unknown as () => boolean)).toThrow("check must be a function");
  });

  it("reads the row ids an entry or scope form names", () => {
    expect(accessIds({ entry: "Read" }, { id: "t1" })).toEqual(["t1"]);
    expect(accessIds({ entry: "Read", id: "projectId" }, { projectId: "p1" })).toEqual(["p1"]);
    expect(accessIds({ entry: "Read", id: "ids" }, { ids: ["a", "b"] })).toEqual(["a", "b"]);
    expect(
      accessIds(
        { scope: "Read", of: project, id: (input) => (input as { p: string }).p },
        { p: "p9" },
      ),
    ).toEqual(["p9"]);
    for (const input of [{}, { id: "" }, { id: 3 }, { id: [] }, { id: ["a", 1] }, null]) {
      expect(() => accessIds({ entry: "Read" }, input), JSON.stringify(input)).toThrow(
        "Insufficient permissions",
      );
    }
  });
});
