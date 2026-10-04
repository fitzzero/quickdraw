// The admin kit's client half (RFC 0003 section 12.4) against a real server
// on PGlite (`../server/kits/admin/__tests__/fixture.ts`): `qd.<service>.admin`
// gathers the admin methods' members, and `useAdminServices` lists the
// services whose `adminMeta` answers the user, by display name; a mock
// client does the same from its stubs.

import { render } from "@testing-library/react";
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
import { useAdminServices } from "./admin";
import { createQuickdrawClient } from "./createClient";

const kit = adminApp();
const qd = createQuickdrawClient({ task: taskContract, project: projectContract });

function Services({ client }: { readonly client: object }) {
  const { services, isLoading } = useAdminServices(client);
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

  it("leaves out a service whose adminMeta refuses the user, the owner of its rows included", async () => {
    const { app } = await kit.start();
    const view = await renderWithQuickdraw(<Services client={qd} />, {
      app,
      as: as(kit.board().ada),
      client: qd,
    });
    await view.findByText("none");
  });

  it("lists a mock client's services from their adminMeta stubs", async () => {
    const mock = createMockClient({ task: taskContract, project: projectContract });
    const view = render(<Services client={mock} />);
    expect(view.getByText("loading")).toBeTruthy();
    const meta: AdminServiceMeta = { serviceName: "taskService", displayName: "Tasks", fields: [] };
    mock.task.admin.adminMeta.mockResolvedValue(meta);
    await view.findByText("task: Tasks");
    // The namespace's member is the service's: one stub.
    expect(mock.task.admin.adminMeta).toBe(mock.task.adminMeta);
    expect(mock.task.adminMeta.calls.length).toBeGreaterThan(0);
  });
});
