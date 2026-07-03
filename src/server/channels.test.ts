import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { z } from "zod";
import type { Server as SocketIOServer } from "socket.io";
import type { AccessLevel } from "../shared/types";
import { channelEventName } from "../shared/types";
import { BaseService } from "./BaseService";
import type { QuickdrawSocket, PrismaDelegate, BaseServiceInstance } from "./types";
import { createTestServer, type TestServer, type TestClient, waitForEvent } from "./testing";

// Minimal entity type for testing
interface TestWorld {
  id: string;
  name: string;
}

type TestCreateInput = Record<string, unknown>;
type TestUpdateInput = Record<string, unknown>;

const store = new Map<string, TestWorld>([["world-1", { id: "world-1", name: "World 1" }]]);

const mockDelegate: PrismaDelegate<TestWorld, TestCreateInput, TestUpdateInput> = {
  findUnique: async (args) => store.get((args.where as { id: string }).id) ?? null,
  findMany: async () => Array.from(store.values()),
  create: async (args) => args.data as unknown as TestWorld,
  update: async (args) => store.get((args.where as { id: string }).id)!,
  delete: async (args) => store.get((args.where as { id: string }).id)!,
  count: async () => store.size,
};

interface InputPayload {
  seq: number;
  dx: number;
  dy: number;
}

const inputSchema = z.object({
  seq: z.number().int(),
  dx: z.number(),
  dy: z.number(),
});

type GameChannels = {
  input: InputPayload;
  adminPing: { note: string };
};

type GameMethods = Record<string, never>;

class GameTestService extends BaseService<
  TestWorld,
  TestCreateInput,
  TestUpdateInput,
  GameMethods,
  GameChannels
> {
  public received: Array<{ userId: string; payload: InputPayload }> = [];
  public adminPings: string[] = [];
  public handlerErrors = 0;

  constructor() {
    super({ serviceName: "gameTestService", hasEntryACL: false });
    this.setDelegate(mockDelegate);

    this.defineChannel(
      "input",
      "Read",
      (payload, ctx) => {
        if (payload.seq === -999) {
          this.handlerErrors++;
          throw new Error("handler boom");
        }
        this.received.push({ userId: ctx.userId, payload });
      },
      {
        schema: inputSchema,
        ratePerSecond: 30,
        burst: 60,
        requireRoom: () => this.getRoomName("world-1"),
      },
    );

    this.defineChannel(
      "adminPing",
      "Admin",
      (payload) => {
        this.adminPings.push(payload.note);
      },
      { schema: z.object({ note: z.string() }) },
    );
  }

  // Allow any authenticated user to subscribe (room gate for the channel)
  protected override checkAccess(
    _userId: string,
    _entryId: string,
    _requiredLevel: AccessLevel,
    _socket: QuickdrawSocket,
  ): boolean {
    return true;
  }
}

function flush(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("channels", () => {
  let server: TestServer;
  let subscribed: TestClient;
  let outsider: TestClient;
  const service = new GameTestService();
  const inputEvent = channelEventName("gameTestService", "input");

  beforeAll(async () => {
    server = await createTestServer({
      services: {
        gameTestService: service as unknown as BaseServiceInstance,
      },
    });

    subscribed = await server.connectAs("user-sub");
    outsider = await server.connectAs("user-out");

    // subscribed joins the world room (which gates the input channel)
    await subscribed.emit("gameTestService:subscribe", { entryId: "world-1" });
  });

  afterAll(async () => {
    subscribed?.close();
    outsider?.close();
    if (server) await server.stop();
  });

  it("delivers channel messages from a subscribed, authenticated socket", async () => {
    service.received = [];

    subscribed.socket.emit(inputEvent, { seq: 1, dx: 1, dy: 0 });
    subscribed.socket.emit(inputEvent, { seq: 2, dx: 0, dy: 1 });
    await flush();

    expect(service.received).toHaveLength(2);
    expect(service.received[0]).toEqual({
      userId: "user-sub",
      payload: { seq: 1, dx: 1, dy: 0 },
    });
    expect(service.received[1]!.payload.seq).toBe(2);
  });

  it("drops messages from sockets not in the required room", async () => {
    service.received = [];

    outsider.socket.emit(inputEvent, { seq: 3, dx: 1, dy: 1 });
    await flush();

    expect(service.received).toHaveLength(0);
  });

  it("drops messages that fail schema validation", async () => {
    service.received = [];

    subscribed.socket.emit(inputEvent, { seq: "not-a-number", dx: 1 });
    subscribed.socket.emit(inputEvent, "garbage");
    subscribed.socket.emit(inputEvent, null);
    await flush();

    expect(service.received).toHaveLength(0);
  });

  it("enforces Moderate/Admin service-level access on channels", async () => {
    const adminEvent = channelEventName("gameTestService", "adminPing");
    service.adminPings = [];

    // Regular user: dropped (no serviceAccess in test auth)
    subscribed.socket.emit(adminEvent, { note: "from-regular" });
    await flush();
    expect(service.adminPings).toHaveLength(0);
  });

  it("drops excess messages via the per-channel token bucket without disconnecting", async () => {
    service.received = [];

    // Flood well past the burst of 60 in one go
    for (let i = 0; i < 200; i++) {
      subscribed.socket.emit(inputEvent, { seq: 100 + i, dx: 0, dy: 0 });
    }
    await flush(200);

    // Bucket allows ~burst immediately (plus a trickle of refill)
    expect(service.received.length).toBeGreaterThan(0);
    expect(service.received.length).toBeLessThan(100);
    // Moderate flooding does not disconnect
    expect(subscribed.socket.connected).toBe(true);
  });

  it("swallows handler errors without crashing or acking", async () => {
    const before = service.handlerErrors;

    // Wait for bucket refill after the flood test
    await flush(1200);

    subscribed.socket.emit(inputEvent, { seq: -999, dx: 0, dy: 0 });
    await flush();

    expect(service.handlerErrors).toBe(before + 1);
    expect(subscribed.socket.connected).toBe(true);

    // Channel still works after a handler error
    service.received = [];
    subscribed.socket.emit(inputEvent, { seq: 7, dx: 1, dy: 0 });
    await flush();
    expect(service.received).toHaveLength(1);
  });

  it("emitToRoomVolatile reaches room members as a normal event", async () => {
    const snapshotPromise = waitForEvent<{ tick: number }>(subscribed.socket, "game:snapshot");

    service.emitToRoomVolatile(service.getRoomName("world-1"), "game:snapshot", { tick: 42 });

    const snapshot = await snapshotPromise;
    expect(snapshot.tick).toBe(42);
  });

  it("emitToRoomVolatile does not reach sockets outside the room", async () => {
    let outsiderGotIt = false;
    outsider.socket.on("game:snapshot", () => {
      outsiderGotIt = true;
    });

    service.emitToRoomVolatile(service.getRoomName("world-1"), "game:snapshot", { tick: 43 });
    await flush();

    expect(outsiderGotIt).toBe(false);
  });

  it("drops channel messages from unauthenticated sockets", async () => {
    // Connect without auth (server allows anonymous connections)
    const { io: ioClient } = await import("socket.io-client");
    const anonSocket = ioClient(`http://localhost:${server.port}`, {
      transports: ["websocket"],
      autoConnect: true,
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("connect timeout")), 5000);
      anonSocket.on("connect", () => {
        clearTimeout(timeout);
        resolve();
      });
      anonSocket.on("connect_error", () => {
        clearTimeout(timeout);
        // Server may reject anonymous sockets entirely — equally a pass
        resolve();
      });
    });

    service.received = [];
    if (anonSocket.connected) {
      anonSocket.emit(inputEvent, { seq: 9, dx: 1, dy: 0 });
      await flush();
    }
    expect(service.received).toHaveLength(0);
    anonSocket.close();
  });

  it("registers channels in the registry (visible via io listeners)", () => {
    const io = server.result.io as SocketIOServer;
    expect(io).toBeDefined();
    expect(service.getPublicChannels()).toHaveLength(2);
    expect(service.getPublicChannels().map((c) => c.name)).toEqual(["input", "adminPing"]);
  });
});

describe("rate limiter excludePrefixes", () => {
  it("plumbs excludePrefixes through createRateLimiter options", async () => {
    const { createRateLimiter } = await import("./rateLimit");
    const { CHANNEL_EVENT_PREFIX } = await import("../shared/types");

    const limiter = createRateLimiter({
      maxRequests: 10,
      excludePrefixes: [CHANNEL_EVENT_PREFIX],
    });

    expect(limiter.options.excludePrefixes).toEqual(["channel:"]);
    // Default stays backward compatible
    const plain = createRateLimiter({ maxRequests: 10 });
    expect(plain.options.excludePrefixes).toEqual([]);
  });
});
