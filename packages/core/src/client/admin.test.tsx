// The admin kit's client half (RFC 0003 section 12.4) against a real server
// on PGlite (`../server/kits/admin/__tests__/fixture.ts`): `qd.<service>.admin`
// gathers the admin methods' members, and `useAdminServices` lists the
// services whose `adminMeta` answers the user, by display name; a mock
// client does the same from its stubs.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ADMIN_METHODS, type AdminServiceMeta } from "../index";
import { projectContract, projectService } from "../server/emit/__tests__/live";
import type { CallRecord } from "../server/index";
import {
  adminApp,
  as,
  defineTaskService,
  serviceAdmin,
  taskContract,
} from "../server/kits/admin/__tests__/fixture";
import { createMockClient, renderWithQuickdraw } from "../testing/client";
import { createTestApp, type TestApp } from "../testing/index";
import { admin as adminKit, defineContract } from "../index";
import { useAdminServices } from "./admin";
import { adminOf } from "./adminScreen";
import { createQuickdrawClient } from "./createClient";

const kit = adminApp();
const qd = createQuickdrawClient({ task: taskContract, project: projectContract });

function Services({
  client,
  requires,
}: {
  readonly client: object;
  readonly requires?: "Moderate" | null;
}) {
  const { services, isLoading } = useAdminServices(
    client,
    requires === undefined ? {} : { requires },
  );
  if (isLoading) {
    return <p>loading</p>;
  }
  const names = services.map((service) => `${service.key}: ${service.displayName}`);
  return <p>{names.length === 0 ? "none" : names.join(", ")}</p>;
}

function Meta() {
  const { data } = qd.task.admin.adminMeta.useQuery();
  return <p>{data === undefined ? "no meta" : `${String(data.fields.length)} fields`}</p>;
}

describe("qd.<service>.admin", () => {
  it("holds the service's own members of the admin methods, and only a service with the kit has it", () => {
    expect(Object.keys(qd.task.admin)).toEqual([...ADMIN_METHODS]);
    expect(qd.task.admin.adminList).toBe(qd.task.adminList);
    expect(qd.task.admin.adminUpdate).toBe(qd.task.adminUpdate);
    expect(Object.isFrozen(qd.task.admin)).toBe(true);
    expect("admin" in qd.project).toBe(false);
  });
});

describe("adminOf", () => {
  it("gives a service's admin members by what the kit made them for, the same object every time", () => {
    const screen = adminOf(qd, "task");
    expect(screen.adminList).toBe(qd.task.admin.adminList);
    expect(screen.adminMeta).toBe(qd.task.admin.adminMeta);
    expect(screen.adminUpdate).toBe(qd.task.adminUpdate);
    expect(adminOf(qd, "task")).toBe(screen);
    expect(Object.isFrozen(screen)).toBe(true);
    expect(() => adminOf(qd, "project" as "task")).toThrow(
      'adminOf: "project" is not a service of this client with the admin kit',
    );
  });

  it("refuses a service that exposes no adminMeta or adminList, which a screen reads", () => {
    const partial = createQuickdrawClient({
      task: defineContract("taskService", {
        entity: taskContract.entity,
        methods: {
          ...adminKit.contract({ entity: taskContract.entity, expose: ["adminGet"] }),
        },
      }),
    });
    expect(() => adminOf(partial, "task")).toThrow(
      'adminOf: "task" exposes no adminMeta or adminList, which an admin screen reads',
    );
  });

  it("serves a metadata-driven screen against a real server, sorting by a field named at run time", async () => {
    const { app } = await kit.start();
    function Screen({ serviceKey }: { readonly serviceKey: "task" }) {
      const admin = adminOf(qd, serviceKey);
      const { data: meta } = admin.adminMeta.useQuery(undefined);
      const sortable = meta?.fields.find((field) => field.sortable)?.name;
      const { data: page } = admin.adminList.useQuery(
        sortable === undefined ? undefined : { page: 1, sort: { field: sortable } },
        { enabled: sortable !== undefined },
      );
      return <p>{page === undefined ? "loading" : `${String(page.total)} rows`}</p>;
    }
    const view = await renderWithQuickdraw(<Screen serviceKey="task" />, {
      app,
      as: serviceAdmin(kit.board().ed),
      client: qd,
    });
    await view.findByText(/^\d+ rows$/);
  });
});

describe("useAdminServices", () => {
  it("lists the services whose adminMeta answers the user, by display name, and shares adminMeta's cache", async () => {
    const records: CallRecord[] = [];
    const app = await createTestApp({
      services: [projectService, defineTaskService({ displayName: "Work items" })],
      db: kit.harness().db,
      onCall: (record) => records.push(record),
    });
    kit.track(app as unknown as TestApp);
    const view = await renderWithQuickdraw(
      <>
        <Services client={qd} />
        <Meta />
      </>,
      { app, as: serviceAdmin(kit.board().ed), client: qd },
    );
    await view.findByText("task: Work items");
    await view.findByText("11 fields");
    // One call answered both: the list and the screen read the same cached result.
    expect(records.map((record) => [record.method, record.outcome])).toEqual([["adminMeta", "ok"]]);
  });

  it("asks nothing of a service the user's grants rule out, the owner of its rows included", async () => {
    const records: CallRecord[] = [];
    const app = await createTestApp({
      services: [projectService, defineTaskService({})],
      db: kit.harness().db,
      onCall: (record) => records.push(record),
    });
    kit.track(app as unknown as TestApp);
    const view = await renderWithQuickdraw(<Services client={qd} />, {
      app,
      as: as(kit.board().ada),
      client: qd,
    });
    await view.findByText("none");
    // The hello's grants hold no Admin on the task service: not one adminMeta call, then or after a reconnect.
    await view.disconnect();
    await view.reconnect();
    await view.findByText("none");
    expect(records.filter((record) => record.method === "adminMeta")).toEqual([]);
  });

  it("asks a service the grants allow, and once refused asks it again only when the grant changes", async () => {
    const records: CallRecord[] = [];
    const app = await createTestApp({
      services: [projectService, defineTaskService({})],
      db: kit.harness().db,
      onCall: (record) => records.push(record),
    });
    kit.track(app as unknown as TestApp);
    const metaCalls = () =>
      records.filter((record) => record.method === "adminMeta").map((record) => record.outcome);
    // Moderate meets `requires: "Moderate"`, but the kit's adminMeta needs Admin.
    const moderator = as(kit.board().ed, { taskService: "Moderate" });
    const view = await renderWithQuickdraw(<Services client={qd} requires="Moderate" />, {
      app,
      as: moderator,
      client: qd,
    });
    await view.findByText("none");
    expect(metaCalls()).toEqual(["FORBIDDEN"]);
    await view.disconnect();
    await view.reconnect();
    view.rerender(<Services client={qd} requires={null} />);
    await view.findByText("none");
    // The same grant after the reconnect: the refusal stands, nothing is asked again.
    expect(metaCalls()).toEqual(["FORBIDDEN"]);
  });

  it("lists a mock client's services from their adminMeta stubs, as its session's grants allow", async () => {
    const mock = createMockClient(
      { task: taskContract, project: projectContract },
      { session: { userId: "ada", serviceAccess: { taskService: "Admin" } } },
    );
    const view = render(<Services client={mock} />);
    expect(view.getByText("loading")).toBeTruthy();
    const meta: AdminServiceMeta = { serviceName: "taskService", displayName: "Tasks", fields: [] };
    mock.task.admin.adminMeta.mockResolvedValue(meta);
    await view.findByText("task: Tasks");
    // The namespace's member is the service's: one stub.
    expect(mock.task.admin.adminMeta).toBe(mock.task.adminMeta);
    expect(mock.task.adminMeta.calls.length).toBeGreaterThan(0);
    // Without the grant the service is left out, and its stub is not asked.
    const asked = mock.task.adminMeta.calls.length;
    act(() => {
      mock.$session({ serviceAccess: {} });
    });
    await view.findByText("none");
    expect(mock.task.adminMeta.calls.length).toBe(asked);
  });
});
