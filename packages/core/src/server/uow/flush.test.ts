import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../contract/logger";
import { nextRev } from "../rev";
import { combineSinks, flushWrites } from "./flush";
import { noFlushSink, type FlushInfo, type FlushSink } from "./flushSink";
import type { UnitOfWorkScope, WriteRecord } from "./types";

function captureLogger(): Logger & { readonly entries: { level: string; message: string }[] } {
  const entries: { level: string; message: string }[] = [];
  const at =
    (level: string) =>
    (message: string): void => {
      entries.push({ level, message });
    };
  const logger = {
    entries,
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: () => logger,
  };
  return logger;
}

const update = (id: string, field: string): WriteRecord => ({
  model: "task",
  id,
  op: "update",
  fields: [field],
});

function scopeWith(sink: FlushSink): UnitOfWorkScope {
  return {
    service: "taskService",
    method: "rename",
    kind: "mutation",
    requestId: "req-1",
    transport: "socket",
    sink,
  };
}

describe("nextRev", () => {
  it("is the time in milliseconds, and always more than the last one", () => {
    const first = nextRev();
    const second = nextRev();
    expect(second).toBeGreaterThan(first);
    expect(first).toBeGreaterThanOrEqual(Date.now() - 1000);
  });

  it("keeps rising when the clock steps back", () => {
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(2_000_000_000_000);
      const ahead = nextRev();
      now.mockReturnValue(1_000_000_000_000);
      expect(nextRev()).toBe(ahead + 1);
    } finally {
      now.mockRestore();
    }
  });
});

describe("flushWrites", () => {
  it("merges the writes per row, takes one revision and hands both to the sink", async () => {
    const received: [readonly WriteRecord[], FlushInfo][] = [];
    const sink: FlushSink = {
      flush: (writes, info) => {
        received.push([writes, info]);
        return Promise.resolve();
      },
    };
    const before = nextRev();
    await flushWrites(
      [update("t1", "title"), update("t2", "title"), update("t1", "status")],
      scopeWith(sink),
      captureLogger(),
    );
    expect(received).toHaveLength(1);
    const [writes, info] = received[0] ?? [[], undefined];
    expect(writes).toEqual([
      { model: "task", id: "t1", op: "update", fields: ["title", "status"] },
      update("t2", "title"),
    ]);
    expect(info).toEqual({
      service: "taskService",
      method: "rename",
      kind: "mutation",
      requestId: "req-1",
      transport: "socket",
      rev: expect.any(Number),
    });
    expect(info?.rev).toBeGreaterThan(before);
  });

  it("calls no sink and takes no revision when nothing was written", async () => {
    const flush = vi.fn(() => Promise.resolve());
    // A clock behind the last revision makes each revision exactly one more.
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const before = nextRev();
      await flushWrites([], scopeWith({ flush }), captureLogger());
      expect(flush).not.toHaveBeenCalled();
      expect(nextRev()).toBe(before + 1);
    } finally {
      now.mockRestore();
    }
  });

  it("calls no sink and takes no revision when the unit only created rows it deleted again", async () => {
    const flush = vi.fn(() => Promise.resolve());
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const before = nextRev();
      await flushWrites(
        [
          { model: "task", id: "t9", op: "create", fields: ["title"], after: { projectId: "p1" } },
          { model: "task", id: "t9", op: "delete", fields: [], before: { projectId: "p1" } },
        ],
        scopeWith({ flush }),
        captureLogger(),
      );
      expect(flush).not.toHaveBeenCalled();
      expect(nextRev()).toBe(before + 1);
    } finally {
      now.mockRestore();
    }
  });

  it("logs a failing sink with the rows it failed on, and never rejects", async () => {
    const logger = captureLogger();
    const sink: FlushSink = { flush: () => Promise.reject(new Error("socket gone")) };
    await expect(
      flushWrites([update("t1", "title")], scopeWith(sink), logger),
    ).resolves.toBeUndefined();
    expect(logger.entries).toEqual([
      { level: "error", message: "Flushing writes failed; the response was already sent" },
    ]);
  });
});

describe("combineSinks", () => {
  it("returns a lone sink as it is, and a sink that does nothing for none", () => {
    const sink: FlushSink = { flush: () => Promise.resolve() };
    expect(combineSinks([sink], captureLogger())).toBe(sink);
    expect(combineSinks([], captureLogger())).toBe(noFlushSink);
  });

  it("runs every sink in order, and tells the others when one fails", async () => {
    const logger = captureLogger();
    const events: string[] = [];
    const sink = (name: string, fails: boolean): FlushSink => ({
      flush: (writes, info) => {
        events.push(`${name}:flush:${writes.length}:${info.rev}`);
        return fails ? Promise.reject(new Error(`${name} failed`)) : Promise.resolve();
      },
      onFlushError: (writes, info, error) => {
        events.push(`${name}:error:${writes.length}:${info.rev}:${(error as Error).message}`);
      },
    });
    const combined = combineSinks(
      [sink("access", false), sink("entities", true), sink("collections", false)],
      logger,
    );
    await combined.flush([update("t1", "title")], {
      requestId: "r",
      transport: "internal",
      rev: 7,
    });
    expect(events).toEqual([
      "access:flush:1:7",
      "entities:flush:1:7",
      "collections:flush:1:7",
      "access:error:1:7:entities failed",
      "collections:error:1:7:entities failed",
    ]);
    expect(logger.entries).toEqual([
      { level: "error", message: "A flush sink failed; the response was already sent" },
    ]);
  });

  it("logs a sink whose onFlushError throws, and still resolves", async () => {
    const logger = captureLogger();
    const combined = combineSinks(
      [
        { flush: () => Promise.reject(new Error("first")) },
        {
          flush: () => Promise.resolve(),
          onFlushError: () => {
            throw new Error("second");
          },
        },
      ],
      logger,
    );
    await expect(
      combined.flush([update("t1", "title")], { requestId: "r", transport: "internal", rev: 1 }),
    ).resolves.toBeUndefined();
    expect(logger.entries.map((entry) => entry.message)).toEqual([
      "A flush sink failed; the response was already sent",
      "A flush sink failed to handle another sink's failure",
    ]);
  });
});
