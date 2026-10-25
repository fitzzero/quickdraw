// The admin kit's client half (RFC 0003 section 12.4) against a real server
// on PGlite (`../server/kits/admin/__tests__/fixture.ts`): `qd.<service>.admin`
// gathers the admin methods' members, whose reads of rows are read again on
// every mount, and `useAdminServices` lists the services whose `adminMeta`
// answers the user, by display name; a mock client does the same from its
// stubs.

import { act, fireEvent, render } from "@testing-library/react";
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

type TaskAdmin = typeof qd.task.admin;

/** Row `id`'s title on a page of `adminList`, read with `staleTime` when one is given, and a read in flight. */
function ListedTitle({
  admin,
  id,
  staleTime,
}: {
  readonly admin: TaskAdmin;
  readonly id: string;
  readonly staleTime?: number;
}) {
  // A page size of its own, so the two readers cache apart.
  const { data, isFetching } = admin.adminList.useQuery(
    { page: 1, pageSize: staleTime === undefined ? 20 : 50 },
    staleTime === undefined ? {} : { staleTime },
  );
  const name = staleTime === undefined ? "list" : `list kept ${String(staleTime)} ms`;
  const title = data?.items.find((row) => row.id === id)?.title ?? "loading";
  return <p>{`${name}: ${title}${isFetching ? ", reading" : ""}`}</p>;
}

/** How many fields `adminMeta` gives, and a read in flight. */
function MetaFields({ admin }: { readonly admin: TaskAdmin }) {
  const { data, isFetching } = admin.adminMeta.useQuery();
  const fields = data === undefined ? "loading" : String(data.fields.length);
  return <p>{`meta: ${fields}${isFetching ? ", reading" : ""}`}</p>;
}

/** The readers, mounted while `shown`. */
function AdminReads({
  admin,
  id,
  shown,
}: {
  readonly admin: TaskAdmin;
  readonly id: string;
  readonly shown: boolean;
}) {
  if (!shown) {
    return <p>closed</p>;
  }
  return (
    <>
      <ListedTitle admin={admin} id={id} />
      <ListedTitle admin={admin} id={id} staleTime={60_000} />
      <MetaFields admin={admin} />
    </>
  );
}

describe("the kit's reads of rows", () => {
  it("are read again whenever a screen mounts, unless the caller passes a staleTime; adminMeta stays cached", async () => {
    const records: CallRecord[] = [];
    const app = await createTestApp({
      services: [projectService, defineTaskService({})],
      db: kit.harness().db,
      onCall: (record) => records.push(record),
    });
    kit.track(app as unknown as TestApp);
    const { t1, ed } = kit.board();
    const view = await renderWithQuickdraw(<AdminReads admin={qd.task.admin} id={t1} shown />, {
      app,
      as: serviceAdmin(ed),
      client: qd,
    });
    await view.findByText("list: T1");
    await view.findByText("list kept 60000 ms: T1");
    await view.findByText(/^meta: \d+$/);
    view.rerender(<AdminReads admin={qd.task.admin} id={t1} shown={false} />);
    // Written elsewhere: the kit's reads watch nothing, so no frame tells the client.
    await kit.harness().prisma.task.update({ where: { id: t1 }, data: { title: "Renamed" } });
    view.rerender(<AdminReads admin={qd.task.admin} id={t1} shown />);
    // The cached page at once, and read again; a staleTime of the caller's, and adminMeta, keep theirs.
    expect(view.getByText("list: T1, reading")).toBeTruthy();
    expect(view.getByText("list kept 60000 ms: T1")).toBeTruthy();
    expect(view.getByText(/^meta: \d+$/)).toBeTruthy();
    await view.findByText("list: Renamed");
    const calls = (method: string) => records.filter((record) => record.method === method).length;
    expect([calls("adminList"), calls("adminMeta")]).toEqual([3, 1]);
  });

  it("ask a mock client's stub again whenever a screen mounts, as on the typed client", async () => {
    const mock = createMockClient({ task: taskContract, project: projectContract });
    let title = "T1";
    mock.task.admin.adminList.mockImplementation((input) => {
      const pageSize = input?.pageSize ?? 20;
      const row = {
        id: "t1",
        projectId: "p1",
        title,
        status: "open" as const,
        ordinal: 10,
        pinned: false,
        details: null,
        assigneeId: null,
        notes: null,
        createdAt: "2026-10-22T00:00:00.000Z",
        updatedAt: "2026-10-22T00:00:00.000Z",
      };
      return { items: [row], total: 1, page: 1, pageSize, totalPages: 1 };
    });
    mock.task.admin.adminMeta.mockResolvedValue({
      serviceName: "taskService",
      displayName: "Tasks",
      fields: [],
    });
    const view = render(<AdminReads admin={mock.task.admin} id="t1" shown />);
    await view.findByText("list: T1");
    await view.findByText("list kept 60000 ms: T1");
    await view.findByText("meta: 0");
    view.rerender(<AdminReads admin={mock.task.admin} id="t1" shown={false} />);
    title = "Renamed";
    view.rerender(<AdminReads admin={mock.task.admin} id="t1" shown />);
    expect(view.getByText("list kept 60000 ms: T1")).toBeTruthy();
    expect(view.getByText("meta: 0")).toBeTruthy();
    await view.findByText("list: Renamed");
    const asked = (pageSize: number) =>
      mock.task.admin.adminList.calls.filter((input) => input?.pageSize === pageSize).length;
    expect([asked(20), asked(50), mock.task.admin.adminMeta.calls.length]).toEqual([2, 1, 1]);
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

  it("shows the row a write returned once setData put it in adminGet's cache, with no new read", async () => {
    const records: CallRecord[] = [];
    const app = await createTestApp({
      services: [projectService, defineTaskService({})],
      db: kit.harness().db,
      onCall: (record) => records.push(record),
    });
    kit.track(app as unknown as TestApp);
    const { adminGet, adminUpdate } = adminOf(qd, "task");
    if (adminGet === undefined || adminUpdate === undefined) {
      throw new Error("the fixture's contract exposes adminGet and adminUpdate");
    }
    const RowPanel = ({ id }: { readonly id: string }) => {
      const { data: row } = adminGet.useQuery({ id });
      const update = adminUpdate.useMutation({
        // The kit's reads are not live: the panel shows the row the write returned.
        onSuccess: (written) => {
          adminGet.setData({ id: written.id }, written);
        },
      });
      return (
        <>
          <p>{typeof row?.title === "string" ? `title ${row.title}` : "loading"}</p>
          <button type="button" onClick={() => update.mutate({ id, data: { title: "Renamed" } })}>
            rename
          </button>
        </>
      );
    };
    const view = await renderWithQuickdraw(<RowPanel id={kit.board().t1} />, {
      app,
      as: serviceAdmin(kit.board().ed),
      client: qd,
    });
    await view.findByText("title T1");
    fireEvent.click(view.getByText("rename"));
    await view.findByText("title Renamed");
    expect(records.map((record) => [record.method, record.outcome])).toEqual([
      ["adminGet", "ok"],
      ["adminUpdate", "ok"],
    ]);
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
