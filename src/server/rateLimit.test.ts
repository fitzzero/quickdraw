import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CHANNEL_EVENT_PREFIX } from "../shared/types";
import { BaseRpcService } from "./BaseRpcService";
import { applyRateLimitMiddleware, createRateLimiter, type RateLimitOptions } from "./rateLimit";
import { createTestServer, type TestClient, type TestServer } from "./testing";

class PingService extends BaseRpcService<{
  ping: { payload: Record<string, never>; response: { pong: true } };
}> {
  constructor() {
    super({ serviceName: "pingService" });
    this.defineMethod("ping", "Read", async () => ({ pong: true }));
  }
}

/**
 * Socket.IO accepts an event whose name is a number and runs socket
 * middleware inside process.nextTick, so a middleware that throws on one
 * raises an uncaught exception, which exits a production process.
 */
describe("applyRateLimitMiddleware with a numeric event name", () => {
  let server: TestServer | null = null;
  const clients: TestClient[] = [];
  const uncaught: Error[] = [];
  const recordUncaught = (error: Error): void => {
    uncaught.push(error);
  };

  beforeEach(() => {
    uncaught.length = 0;
    process.on("uncaughtException", recordUncaught);
  });

  afterEach(async () => {
    process.off("uncaughtException", recordUncaught);
    for (const client of clients.splice(0)) {
      client.close();
    }
    await server?.stop();
    server = null;
  });

  it.each<[string, RateLimitOptions]>([
    ["default options", {}],
    [
      "excluded events and prefixes",
      { excludeEvents: ["pingService:subscribe"], excludePrefixes: [CHANNEL_EVENT_PREFIX] },
    ],
  ])("lets it through and keeps serving (%s)", async (_label, options) => {
    server = await createTestServer({ services: { pingService: new PingService() } });
    applyRateLimitMiddleware(server.result.io, createRateLimiter(options));

    const client = await server.connectAs("user-1");
    clients.push(client);
    // Socket.IO's types allow only string event names; its parser accepts a number.
    client.socket.emit(42 as unknown as string, "x");
    await expect(client.emit("pingService:ping", {})).resolves.toEqual({ pong: true });

    const later = await server.connectAs("user-2");
    clients.push(later);
    await expect(later.emit("pingService:ping", {})).resolves.toEqual({ pong: true });

    expect(uncaught).toEqual([]);
  });
});
