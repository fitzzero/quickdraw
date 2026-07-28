import { describe, it, expect, afterEach } from "vitest";
import type { AccessLevel } from "../shared/types";
import { BaseRpcService } from "./BaseRpcService";
import type { QuickdrawServerResult } from "./types";
import { createQuickdrawServer } from "./createServer";
import { getAvailablePort, connectAsUser, waitForEvent, type TestClient } from "./testing";

interface AuthInfo {
  userId: string | null;
  serviceAccess: Record<string, AccessLevel>;
  principalType?: string;
}

/**
 * auth:info is emitted the moment the server accepts the connection, so the
 * listener must be attached before connect completes (the real client
 * attaches its listeners at socket creation). Capture it via a one-shot
 * listener installed inside connectAsUser's socket as early as possible.
 */
async function connectCapturingAuthInfo(
  port: number,
  userId: string,
): Promise<{ client: TestClient; authInfo: Promise<AuthInfo> }> {
  let resolveInfo: (info: AuthInfo) => void;
  const authInfo = new Promise<AuthInfo>((resolve) => {
    resolveInfo = resolve;
  });

  const clientPromise = connectAsUser(port, userId);
  // connectAsUser creates the socket synchronously and resolves on connect;
  // poll for the socket handle and attach before the connect round trip ends.
  const client = await clientPromise;
  client.socket.on("auth:info", (info: AuthInfo) => resolveInfo(info));

  // If the event already arrived before the listener attached (lost), ask
  // for a fresh connection cycle by reconnecting — the server re-emits
  // auth:info on every connection.
  const raced = await Promise.race([
    authInfo.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 300)),
  ]);
  if (!raced) {
    client.socket.disconnect();
    client.socket.connect();
  }

  return { client, authInfo };
}

class PingService extends BaseRpcService<{
  ping: { payload: Record<string, never>; response: { pong: true } };
}> {
  constructor() {
    super({ serviceName: "pingService" });
    this.defineMethod("ping", "Read", async () => ({ pong: true }));
  }
}

describe("createQuickdrawServer auth identity", () => {
  let result: QuickdrawServerResult | null = null;
  let client: TestClient | null = null;

  afterEach(async () => {
    client?.close();
    client = null;
    if (result) {
      const r = result;
      result = null;
      await new Promise<void>((resolve) => {
        r.io.close();
        r.httpServer.close(() => resolve());
      });
    }
  });

  async function startServer(
    auth: NonNullable<Parameters<typeof createQuickdrawServer>[0]["auth"]>,
  ): Promise<number> {
    const port = getAvailablePort();
    result = createQuickdrawServer({
      port,
      services: { pingService: new PingService() },
      auth,
    });
    await new Promise<void>((resolve) => result!.httpServer.once("listening", resolve));
    return port;
  }

  it("emits auth:info for a structured identity with inline serviceAccess", async () => {
    const port = await startServer({
      authenticate: async (_socket, auth) => ({
        userId: auth.userId as string,
        principalType: "user",
        claims: { taskId: "task-42" },
        serviceAccess: { pingService: "Admin" as const },
      }),
    });

    const captured = await connectCapturingAuthInfo(port, "user-1");
    client = captured.client;
    const info = await captured.authInfo;

    expect(info.userId).toBe("user-1");
    expect(info.principalType).toBe("user");
    expect(info.serviceAccess).toEqual({ pingService: "Admin" });
  });

  it("supports legacy string returns and consults loadServiceAccess", async () => {
    const loaded: string[] = [];
    const port = await startServer({
      authenticate: async (_socket, auth) => auth.userId as string,
      loadServiceAccess: async (userId) => {
        loaded.push(userId);
        return { pingService: "Moderate" as const };
      },
    });

    const captured = await connectCapturingAuthInfo(port, "user-2");
    client = captured.client;
    const info = await captured.authInfo;

    expect(info.userId).toBe("user-2");
    expect(info.principalType).toBeUndefined();
    expect(info.serviceAccess).toEqual({ pingService: "Moderate" });
    expect(loaded).toContain("user-2");
  });

  it("identity serviceAccess wins over loadServiceAccess", async () => {
    const loaded: string[] = [];
    const port = await startServer({
      authenticate: async (_socket, auth) => ({
        userId: auth.userId as string,
        serviceAccess: { pingService: "Read" as const },
      }),
      loadServiceAccess: async (userId) => {
        loaded.push(userId);
        return { pingService: "Admin" as const };
      },
    });

    const captured = await connectCapturingAuthInfo(port, "user-3");
    client = captured.client;
    const info = await captured.authInfo;

    expect(info.serviceAccess).toEqual({ pingService: "Read" });
    expect(loaded).toEqual([]);
  });

  it("joins authenticated sockets to their user room", async () => {
    const port = await startServer({
      authenticate: async (_socket, auth) => auth.userId as string,
    });

    client = await connectAsUser(port, "user-4");

    const notified = waitForEvent<{ hello: boolean }>(client.socket, "user:notice");
    result!.io.to("user:user-4").emit("user:notice", { hello: true });
    expect((await notified).hello).toBe(true);
  });

  it("BaseRpcService serves methods and returns null subscriptions", async () => {
    const port = await startServer({
      authenticate: async (_socket, auth) => auth.userId as string,
    });

    client = await connectAsUser(port, "user-5");
    const pong = await client.emit<Record<string, never>, { pong: true }>("pingService:ping", {});
    expect(pong).toEqual({ pong: true });

    await expect(
      client.emit("pingService:subscribe", { entryId: "anything" }),
    ).rejects.toThrow("Access denied or entry not found");
  });
});
