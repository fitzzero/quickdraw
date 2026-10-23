// The Redis helper with a missing optional peer. `loadRedisPeers` is replaced
// so it rejects with the error the running Node throws for a package that is
// not installed, captured from a child process.

import { execFileSync } from "node:child_process";
import { Server } from "socket.io";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureLogger } from "./__tests__/fixtures";
import { registerClusterTimeout } from "./cluster/acks";
import { registerDeployment } from "./cluster/deployment";
import { isRedisAdapterAvailable, setupRedisAdapter } from "./redis";
import { isModuleNotFound, loadRedisPeers } from "./redisPeers";

vi.mock("./redisPeers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./redisPeers")>();
  return { ...actual, loadRedisPeers: vi.fn(actual.loadRedisPeers) };
});

/** What `import()` of a package that is not installed throws in this Node, rebuilt here. */
function missingPackageError(): Error {
  const script =
    "import('@fitzzero/quickdraw-peer-that-is-not-installed').catch((error) => " +
    "console.log(JSON.stringify({ code: error.code, message: error.message })))";
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
  });
  const { code, message } = JSON.parse(output) as { code: string; message: string };
  return Object.assign(new Error(message), { code });
}

afterEach(() => {
  vi.mocked(loadRedisPeers).mockReset();
});

/** A Socket.IO server attached to nothing: the helper only ever sets its adapter. */
function io(): Server {
  return new Server();
}

describe("isModuleNotFound", () => {
  it("recognizes the error Node 24 throws, which 4.1's message check missed", () => {
    const error = missingPackageError();
    expect(error).toMatchObject({ code: "ERR_MODULE_NOT_FOUND" });
    expect(error.message).toMatch(/^Cannot find package/);
    expect(error.message).not.toMatch(/Cannot find module|MODULE_NOT_FOUND/);
    expect(isModuleNotFound(error)).toBe(true);
  });

  it("keeps 4.1's message checks for loaders that set no code, and rejects anything else", () => {
    expect(isModuleNotFound(Object.assign(new Error("x"), { code: "MODULE_NOT_FOUND" }))).toBe(
      true,
    );
    expect(isModuleNotFound(new Error("Cannot find module 'redis'"))).toBe(true);
    expect(isModuleNotFound(new Error("connect ECONNREFUSED 127.0.0.1:6379"))).toBe(false);
    expect(isModuleNotFound("Cannot find module 'redis'")).toBe(false);
    expect(isModuleNotFound(null)).toBe(false);
  });
});

describe("setupRedisAdapter", () => {
  it("keys the adapter by the server's cluster.keyPrefix and times its requests by its cluster.timeoutMs, unless told others (RT-2)", async () => {
    const InMemory = new Server().of("/").adapter.constructor;
    const createAdapter = vi.fn(() => InMemory);
    const client = {
      connect: () => Promise.resolve(),
      quit: () => Promise.resolve(),
      duplicate: () => client,
      on: () => client,
    };
    vi.mocked(loadRedisPeers).mockResolvedValue({ createAdapter, createClient: () => client });
    const named = io();
    registerDeployment(named, "myapp");
    registerClusterTimeout(named, 300);
    const logger = captureLogger();
    await setupRedisAdapter(named, { logger });
    await setupRedisAdapter(io(), { logger });
    await setupRedisAdapter(io(), { logger, keyPrefix: "legacy", requestsTimeout: 750 });
    expect(createAdapter.mock.calls.map((call: unknown[]) => call[2])).toEqual([
      { key: "myapp", requestsTimeout: 300 },
      { key: "quickdraw", requestsTimeout: 1000 },
      { key: "legacy", requestsTimeout: 750 },
    ]);
    for (const requestsTimeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(setupRedisAdapter(io(), { logger, requestsTimeout })).rejects.toThrow(
        "setupRedisAdapter: requestsTimeout must be a number of milliseconds above 0",
      );
    }
    expect(createAdapter).toHaveBeenCalledTimes(3);
  });

  it("warns that the peers are missing instead of logging a failure", async () => {
    vi.mocked(loadRedisPeers).mockRejectedValueOnce(missingPackageError());
    const logger = captureLogger();
    const result = await setupRedisAdapter(io(), { logger });
    expect(result.success).toBe(false);
    await expect(result.cleanup()).resolves.toBeUndefined();
    expect(logger.at("error")).toEqual([]);
    expect(logger.at("warn").map((entry) => entry.message)).toEqual([
      "Redis adapter packages not installed. Install @socket.io/redis-adapter and redis for horizontal scaling support.",
    ]);
  });

  it("still logs any other failure as an error", async () => {
    vi.mocked(loadRedisPeers).mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const logger = captureLogger();
    const result = await setupRedisAdapter(io(), { logger });
    expect(result.success).toBe(false);
    expect(logger.at("warn")).toEqual([]);
    expect(logger.at("error")).toEqual([
      {
        level: "error",
        message: "Failed to set up Redis adapter",
        meta: { error: "connect ECONNREFUSED" },
      },
    ]);
  });
});

describe("isRedisAdapterAvailable", () => {
  it("is true when both peers import, and false when one is missing", async () => {
    await expect(isRedisAdapterAvailable()).resolves.toBe(true);
    vi.mocked(loadRedisPeers).mockRejectedValueOnce(missingPackageError());
    await expect(isRedisAdapterAvailable()).resolves.toBe(false);
  });
});
