import { describe, it, expect, afterAll } from "vitest";
import type { Server as SocketIOServer } from "socket.io";
import type { AccessLevel } from "../shared/types";
import { BaseService } from "./BaseService";
import type { QuickdrawSocket, PrismaDelegate } from "./types";
import { createTestServer, type TestServer, type TestClient } from "./testing";

// Minimal entity type for testing
interface TestEntity {
  id: string;
  name: string;
}

type TestCreateInput = Record<string, unknown>;
type TestUpdateInput = Record<string, unknown>;

// In-memory store
const store = new Map<string, TestEntity>();

function seedStore(): void {
  store.clear();
  for (let i = 1; i <= 5; i++) {
    store.set(`entity-${i}`, { id: `entity-${i}`, name: `Entity ${i}` });
  }
}

// Mock Prisma delegate
const mockDelegate: PrismaDelegate<
  TestEntity,
  TestCreateInput,
  TestUpdateInput
> = {
  findUnique: async (args) => {
    const id = (args.where as { id: string }).id;
    return store.get(id) ?? null;
  },
  findMany: async () => Array.from(store.values()),
  create: async (args) => args.data as unknown as TestEntity,
  update: async (args) => {
    const id = (args.where as { id: string }).id;
    return store.get(id) ?? ({ id, ...args.data } as unknown as TestEntity);
  },
  delete: async (args) => {
    const id = (args.where as { id: string }).id;
    const entity = store.get(id)!;
    store.delete(id);
    return entity;
  },
  count: async () => store.size,
};

type TestServiceMethods = Record<string, never>;

class TestService extends BaseService<
  TestEntity,
  TestCreateInput,
  TestUpdateInput,
  TestServiceMethods
> {
  constructor() {
    super({ serviceName: "testService", hasEntryACL: false });
    this.setDelegate(mockDelegate);
  }

  protected override checkAccess(
    _userId: string,
    _entryId: string,
    _requiredLevel: AccessLevel,
    _socket: QuickdrawSocket
  ): boolean {
    return true;
  }
}

// Variant that overrides batch methods for efficiency
class BatchOptimizedService extends BaseService<
  TestEntity,
  TestCreateInput,
  TestUpdateInput,
  TestServiceMethods
> {
  public batchAccessCallCount = 0;
  public batchFindCallCount = 0;

  constructor() {
    super({ serviceName: "batchService", hasEntryACL: false });
    this.setDelegate(mockDelegate);
  }

  protected override checkAccess(
    _userId: string,
    _entryId: string,
    _requiredLevel: AccessLevel,
    _socket: QuickdrawSocket
  ): boolean {
    return true;
  }

  protected override async checkBatchSubscriptionAccess(
    _userId: string,
    entryIds: string[],
    _requiredLevel: AccessLevel,
    _socket: QuickdrawSocket
  ): Promise<Map<string, boolean>> {
    this.batchAccessCallCount++;
    const results = new Map<string, boolean>();
    for (const id of entryIds) {
      results.set(id, store.has(id));
    }
    return results;
  }

  protected override async findByIds(ids: string[]): Promise<TestEntity[]> {
    this.batchFindCallCount++;
    return ids.map((id) => store.get(id)).filter((e) => e != null);
  }
}

describe("batchSubscribe", () => {
  let server: TestServer;
  let client: TestClient;
  const testService = new TestService();
  const batchService = new BatchOptimizedService();

  afterAll(async () => {
    if (client) client.close();
    if (server) await server.stop();
  });

  it("should set up server and connect", async () => {
    seedStore();

    server = await createTestServer({
      services: {
        testService: testService as unknown as import("./types").BaseServiceInstance,
        batchService: batchService as unknown as import("./types").BaseServiceInstance,
      },
    });

    client = await server.connectAs("user-1");
    expect(client.socket.connected).toBe(true);
  });

  it("should subscribe to multiple entities in one call", async () => {
    const result = await client.emit<
      { entryIds: string[]; requiredLevel: string },
      Record<string, TestEntity | null>
    >("testService:batchSubscribe", {
      entryIds: ["entity-1", "entity-2", "entity-3"],
      requiredLevel: "Read",
    });

    expect(result["entity-1"]).toEqual({ id: "entity-1", name: "Entity 1" });
    expect(result["entity-2"]).toEqual({ id: "entity-2", name: "Entity 2" });
    expect(result["entity-3"]).toEqual({ id: "entity-3", name: "Entity 3" });
  });

  it("should return null for non-existent entities", async () => {
    const result = await client.emit<
      { entryIds: string[]; requiredLevel: string },
      Record<string, TestEntity | null>
    >("testService:batchSubscribe", {
      entryIds: ["entity-1", "nonexistent"],
      requiredLevel: "Read",
    });

    expect(result["entity-1"]).toEqual({ id: "entity-1", name: "Entity 1" });
    expect(result["nonexistent"]).toBeNull();
  });

  it("should receive updates after batch subscribing", async () => {
    await client.emit<
      { entryIds: string[]; requiredLevel: string },
      Record<string, TestEntity | null>
    >("testService:batchSubscribe", {
      entryIds: ["entity-4"],
      requiredLevel: "Read",
    });

    const updatePromise = new Promise<Partial<TestEntity>>((resolve) => {
      client.socket.on("testService:update:entity-4", resolve);
    });

    // Trigger an update on the server side
    const io = server.result.io as SocketIOServer;
    io.to("testService:entity-4").emit("testService:update:entity-4", {
      id: "entity-4",
      name: "Updated Entity 4",
    });

    const update = await updatePromise;
    expect(update.name).toBe("Updated Entity 4");
  });

  it("should receive updates for entities that were missing at subscription time", async () => {
    const result = await client.emit<
      { entryIds: string[]; requiredLevel: string },
      Record<string, TestEntity | null>
    >("testService:batchSubscribe", {
      entryIds: ["future-entity"],
      requiredLevel: "Read",
    });

    expect(result["future-entity"]).toBeNull();

    const updatePromise = new Promise<Partial<TestEntity>>((resolve) => {
      client.socket.on("testService:update:future-entity", resolve);
    });

    const io = server.result.io as SocketIOServer;
    io.to("testService:future-entity").emit(
      "testService:update:future-entity",
      { id: "future-entity", name: "Created Later" }
    );

    const update = await updatePromise;
    expect(update.name).toBe("Created Later");
  });

  it("should use overridden batch methods when available", async () => {
    batchService.batchAccessCallCount = 0;
    batchService.batchFindCallCount = 0;

    const result = await client.emit<
      { entryIds: string[]; requiredLevel: string },
      Record<string, TestEntity | null>
    >("batchService:batchSubscribe", {
      entryIds: ["entity-1", "entity-2", "entity-3", "entity-4", "entity-5"],
      requiredLevel: "Read",
    });

    expect(Object.keys(result)).toHaveLength(5);
    expect(result["entity-1"]).toEqual({ id: "entity-1", name: "Entity 1" });
    expect(result["entity-5"]).toEqual({ id: "entity-5", name: "Entity 5" });

    // Batch methods should be called exactly once each (not per entity)
    expect(batchService.batchAccessCallCount).toBe(1);
    expect(batchService.batchFindCallCount).toBe(1);
  });

  it("should reject with error for empty entryIds", async () => {
    await expect(
      client.emit<
        { entryIds: string[]; requiredLevel: string },
        Record<string, TestEntity | null>
      >("testService:batchSubscribe", {
        entryIds: [],
        requiredLevel: "Read",
      })
    ).rejects.toThrow("entryIds must be a non-empty array");
  });
});
