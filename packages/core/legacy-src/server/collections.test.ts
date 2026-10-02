import { describe, it, expect, afterAll, beforeAll } from "vitest";
import type { AccessLevel, CollectionDelta, CollectionSnapshotResponse } from "../shared/types";
import { collectionEventName } from "../shared/types";
import { BaseService } from "./BaseService";
import type { QuickdrawSocket, PrismaDelegate, BaseServiceInstance } from "./types";
import { createTestServer, type TestServer, type TestClient, waitForEvent } from "./testing";

interface Task {
  id: string;
  projectId: string;
  title: string;
  archived: boolean;
  memberIds: string[];
}

interface CardDTO {
  id: string;
  title: string;
  projectId: string;
}

type TaskCreate = Record<string, unknown>;
type TaskUpdate = Record<string, unknown>;

const store = new Map<string, Task>();

const delegate: PrismaDelegate<Task, TaskCreate, TaskUpdate> = {
  findUnique: async (args) => store.get((args.where as { id: string }).id) ?? null,
  findMany: async () => Array.from(store.values()),
  create: async (args) => {
    const entity = args.data as unknown as Task;
    store.set(entity.id, entity);
    return entity;
  },
  update: async (args) => {
    const id = (args.where as { id: string }).id;
    const existing = store.get(id);
    if (!existing) throw new Error("Record not found");
    const updated = { ...existing, ...(args.data as Partial<Task>) };
    store.set(id, updated);
    return updated;
  },
  delete: async (args) => {
    const id = (args.where as { id: string }).id;
    const existing = store.get(id);
    if (!existing) throw new Error("Record not found");
    store.delete(id);
    return existing;
  },
  count: async () => store.size,
};

type TaskCollections = {
  cardsByProject: { item: CardDTO };
  byMember: { item: CardDTO };
  hugeScope: { item: CardDTO };
};

const toCard = (task: Task): CardDTO => ({
  id: task.id,
  title: task.title,
  projectId: task.projectId,
});

class TaskService extends BaseService<
  Task,
  TaskCreate,
  TaskUpdate,
  Record<string, never>,
  Record<string, unknown>,
  Task,
  TaskCollections
> {
  public lastSnapshotOpts: { cursor: string | null; limit: number; userId: string } | null = null;

  constructor() {
    super({ serviceName: "taskService", hasEntryACL: false });
    this.setDelegate(delegate);

    this.defineCollection("cardsByProject", {
      resolveScopeId: (task) => (task.archived ? null : task.projectId),
      checkScopeAccess: (userId) => !userId.startsWith("outsider"),
      snapshot: async (scopeId, opts) => {
        this.lastSnapshotOpts = opts;
        const filtered = Array.from(store.values())
          .filter((t) => t.projectId === scopeId && !t.archived)
          .sort((a, b) => a.title.localeCompare(b.title));
        const offset = opts.cursor ? Number(opts.cursor) : 0;
        const items = filtered.slice(offset, offset + opts.limit).map(toCard);
        return {
          items,
          nextCursor: offset + opts.limit < filtered.length ? String(offset + opts.limit) : null,
          totalCount: filtered.length,
          ids: filtered.map((t) => t.id),
        };
      },
      toItem: toCard,
      defaultLimit: 2,
    });

    this.defineCollection("byMember", {
      resolveScopeId: (task) => task.memberIds,
      checkScopeAccess: (userId, scopeId) => userId === scopeId,
      snapshot: async (scopeId, opts) => {
        const filtered = Array.from(store.values()).filter((t) => t.memberIds.includes(scopeId));
        return {
          items: filtered.slice(0, opts.limit).map(toCard),
          nextCursor: null,
          totalCount: filtered.length,
        };
      },
      toItem: toCard,
    });

    this.defineCollection("hugeScope", {
      resolveScopeId: () => null,
      checkScopeAccess: () => true,
      snapshot: async () => ({
        items: [],
        nextCursor: null,
        totalCount: 5001,
        ids: Array.from({ length: 5001 }, (_, i) => `t-${i}`),
      }),
    });
  }

  protected override checkAccess(
    _userId: string,
    _entryId: string,
    _requiredLevel: AccessLevel,
    _socket: QuickdrawSocket,
  ): boolean {
    return true;
  }

  public createTask(data: TaskCreate): Promise<Task> {
    return this.create(data);
  }

  public updateTask(id: string, data: TaskUpdate): Promise<Task | null> {
    return this.update(id, data);
  }

  public deleteTask(id: string): Promise<boolean> {
    return this.delete(id);
  }
}

type SubscribePayload = { collection: string; scopeId: string; cursor?: string; limit?: number };
type Snapshot = CollectionSnapshotResponse<CardDTO>;

function collectDeltas(client: TestClient, event: string): CollectionDelta<CardDTO>[] {
  const seen: CollectionDelta<CardDTO>[] = [];
  client.socket.on(event, (delta: CollectionDelta<CardDTO>) => seen.push(delta));
  return seen;
}

const flush = (ms = 100): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("collection subscriptions", () => {
  let server: TestServer;
  let member: TestClient;
  let outsider: TestClient;
  const service = new TaskService();
  const p1Event = collectionEventName("taskService", "cardsByProject", "proj-1");
  const p2Event = collectionEventName("taskService", "cardsByProject", "proj-2");

  beforeAll(async () => {
    store.clear();
    store.set("t-1", {
      id: "t-1",
      projectId: "proj-1",
      title: "Alpha",
      archived: false,
      memberIds: ["user-m1"],
    });
    store.set("t-2", {
      id: "t-2",
      projectId: "proj-1",
      title: "Beta",
      archived: false,
      memberIds: [],
    });
    store.set("t-3", {
      id: "t-3",
      projectId: "proj-1",
      title: "Gamma",
      archived: false,
      memberIds: [],
    });

    server = await createTestServer({
      services: { taskService: service as unknown as BaseServiceInstance },
    });
    member = await server.connectAs("user-m1");
    outsider = await server.connectAs("outsider-1");
  });

  afterAll(async () => {
    member?.close();
    outsider?.close();
    if (server) await server.stop();
  });

  it("cursor-less subscribe returns first page, ids, totalCount, and a rev", async () => {
    const snapshot = await member.emit<SubscribePayload, Snapshot>(
      "taskService:collection:subscribe",
      { collection: "cardsByProject", scopeId: "proj-1" },
    );

    expect(snapshot.items.map((i) => i.title)).toEqual(["Alpha", "Beta"]);
    expect(snapshot.nextCursor).toBe("2");
    expect(snapshot.totalCount).toBe(3);
    expect(snapshot.ids).toEqual(["t-1", "t-2", "t-3"]);
    expect(typeof snapshot.rev).toBe("number");
  });

  it("cursor-bearing subscribe pages without ids", async () => {
    const page = await member.emit<SubscribePayload, Snapshot>("taskService:collection:subscribe", {
      collection: "cardsByProject",
      scopeId: "proj-1",
      cursor: "2",
    });

    expect(page.items.map((i) => i.title)).toEqual(["Gamma"]);
    expect(page.nextCursor).toBeNull();
    expect(page.ids).toBeUndefined();
  });

  it("denies access per checkScopeAccess", async () => {
    await expect(
      outsider.emit<SubscribePayload, Snapshot>("taskService:collection:subscribe", {
        collection: "cardsByProject",
        scopeId: "proj-1",
      }),
    ).rejects.toThrow("Access denied or unknown collection");
  });

  it("rejects unknown collections indistinguishably from denial", async () => {
    await expect(
      member.emit<SubscribePayload, Snapshot>("taskService:collection:subscribe", {
        collection: "nope",
        scopeId: "proj-1",
      }),
    ).rejects.toThrow("Access denied or unknown collection");
  });

  it("rejects malformed payloads", async () => {
    await expect(
      member.emit<Record<string, unknown>, Snapshot>("taskService:collection:subscribe", {
        collection: "cardsByProject",
      }),
    ).rejects.toThrow("Invalid collection payload");
  });

  it("clamps requested limits to 500", async () => {
    await member.emit<SubscribePayload, Snapshot>("taskService:collection:subscribe", {
      collection: "cardsByProject",
      scopeId: "proj-1",
      limit: 9999,
    });
    expect(service.lastSnapshotOpts?.limit).toBe(500);
  });

  it("drops ids above the cap and flags idsTruncated", async () => {
    const snapshot = await member.emit<SubscribePayload, Snapshot>(
      "taskService:collection:subscribe",
      { collection: "hugeScope", scopeId: "any" },
    );
    expect(snapshot.ids).toBeUndefined();
    expect(snapshot.idsTruncated).toBe(true);
  });

  it("create() emits an added delta with the toItem DTO to the scope room", async () => {
    const deltaPromise = waitForEvent<CollectionDelta<CardDTO>>(member.socket, p1Event);

    await service.createTask({
      id: "t-4",
      projectId: "proj-1",
      title: "Delta",
      archived: false,
      memberIds: [],
    });

    const delta = await deltaPromise;
    expect(delta.type).toBe("added");
    if (delta.type === "added") {
      expect(delta.item).toEqual({ id: "t-4", title: "Delta", projectId: "proj-1" });
      expect(typeof delta.rev).toBe("number");
    }
  });

  it("update() within a scope emits an updated delta", async () => {
    const deltaPromise = waitForEvent<CollectionDelta<CardDTO>>(member.socket, p1Event);

    await service.updateTask("t-4", { title: "Delta Prime" });

    const delta = await deltaPromise;
    expect(delta.type).toBe("updated");
    if (delta.type === "updated") {
      expect(delta.item.title).toBe("Delta Prime");
    }
  });

  it("a scope move emits removed-from-old and added-to-new", async () => {
    const removedPromise = waitForEvent<CollectionDelta<CardDTO>>(member.socket, p1Event);
    await member.emit<SubscribePayload, Snapshot>("taskService:collection:subscribe", {
      collection: "cardsByProject",
      scopeId: "proj-2",
    });
    const addedPromise = waitForEvent<CollectionDelta<CardDTO>>(member.socket, p2Event);

    await service.updateTask("t-4", { projectId: "proj-2" });

    const removed = await removedPromise;
    const added = await addedPromise;
    expect(removed).toMatchObject({ type: "removed", id: "t-4" });
    expect(added.type).toBe("added");
    if (added.type === "added") {
      expect(added.item.projectId).toBe("proj-2");
    }
  });

  it("predicate exit (archived) emits removed; re-entry emits added", async () => {
    const removedPromise = waitForEvent<CollectionDelta<CardDTO>>(member.socket, p2Event);
    await service.updateTask("t-4", { archived: true });
    expect(await removedPromise).toMatchObject({ type: "removed", id: "t-4" });

    const addedPromise = waitForEvent<CollectionDelta<CardDTO>>(member.socket, p2Event);
    await service.updateTask("t-4", { archived: false });
    const added = await addedPromise;
    expect(added.type).toBe("added");
  });

  it("delete() emits removed to the row's scopes", async () => {
    const deltaPromise = waitForEvent<CollectionDelta<CardDTO>>(member.socket, p2Event);
    await service.deleteTask("t-4");
    expect(await deltaPromise).toMatchObject({ type: "removed", id: "t-4" });
  });

  it("fans out to every scope of a string[] resolveScopeId", async () => {
    const m1Event = collectionEventName("taskService", "byMember", "user-m1");
    await member.emit<SubscribePayload, Snapshot>("taskService:collection:subscribe", {
      collection: "byMember",
      scopeId: "user-m1",
    });
    const m1Deltas = collectDeltas(member, m1Event);

    await service.createTask({
      id: "t-5",
      projectId: "proj-9",
      title: "Shared",
      archived: false,
      memberIds: ["user-m1", "user-m2"],
    });
    await flush();

    expect(m1Deltas).toHaveLength(1);
    expect(m1Deltas[0]!.type).toBe("added");

    // Dropping a member removes it from only that member's scope
    const before = m1Deltas.length;
    await service.updateTask("t-5", { memberIds: ["user-m2"] });
    await flush();
    expect(m1Deltas).toHaveLength(before + 1);
    expect(m1Deltas[before]).toMatchObject({ type: "removed", id: "t-5" });
  });

  it("manual choke points emit the expected deltas", async () => {
    const deltas = collectDeltas(member, p1Event);
    const card: CardDTO = { id: "t-9", title: "Manual", projectId: "proj-1" };

    service.emitCollectionUpsert("cardsByProject", "proj-1", card);
    service.emitCollectionRemove("cardsByProject", "proj-1", "t-9");
    service.emitCollectionMove("cardsByProject", "proj-2", "proj-1", card);
    service.emitCollectionReset("cardsByProject", "proj-1");
    await flush();

    expect(deltas.map((d) => d.type)).toEqual(["updated", "removed", "added", "reset"]);
  });

  it("cursor-bearing subscribes do not join the scope room", async () => {
    const fresh = await server.connectAs("user-fresh");
    await fresh.emit<SubscribePayload, Snapshot>("taskService:collection:subscribe", {
      collection: "cardsByProject",
      scopeId: "proj-1",
      cursor: "0",
    });
    const deltas = collectDeltas(fresh, p1Event);

    service.emitCollectionReset("cardsByProject", "proj-1");
    await flush();

    expect(deltas).toHaveLength(0);
    fresh.close();
  });

  it("unsubscribe leaves the scope room", async () => {
    const client = await server.connectAs("user-leave");
    await client.emit<SubscribePayload, Snapshot>("taskService:collection:subscribe", {
      collection: "cardsByProject",
      scopeId: "proj-1",
    });
    const deltas = collectDeltas(client, p1Event);

    const ack = await client.emit<
      { collection: string; scopeId: string },
      { unsubscribed: boolean }
    >("taskService:collection:unsubscribe", {
      collection: "cardsByProject",
      scopeId: "proj-1",
    });
    expect(ack.unsubscribed).toBe(true);

    service.emitCollectionReset("cardsByProject", "proj-1");
    await flush();
    expect(deltas).toHaveLength(0);
    client.close();
  });

  it("kickFromCollection evicts a specific user's sockets from the scope room", async () => {
    const kicked = await server.connectAs("user-kicked");
    await kicked.emit<SubscribePayload, Snapshot>("taskService:collection:subscribe", {
      collection: "cardsByProject",
      scopeId: "proj-1",
    });
    const kickedDeltas = collectDeltas(kicked, p1Event);
    const memberDeltas = collectDeltas(member, p1Event);

    await service.kickFromCollection("cardsByProject", "proj-1", "user-kicked");
    await flush();

    service.emitCollectionReset("cardsByProject", "proj-1");
    await flush();

    expect(kickedDeltas).toHaveLength(0);
    expect(memberDeltas).toHaveLength(1);
    kicked.close();
  });
});
