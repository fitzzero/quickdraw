// Sharing identical reads (RFC 0003 section 9, step 6), through the
// dispatcher.

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { QuickdrawError, defineContract, listOf, query } from "../index";
import {
  alice,
  bob,
  deferred,
  granted,
  qd,
  setup,
  task,
  taskDefaults,
  tick,
  type Deferred,
} from "./__tests__/fixtures";
import type { DispatchResult, SharedData } from "./index";

function codeOf(result: DispatchResult): string {
  return result.ok ? "ok" : result.error.code;
}

function dataOf(result: DispatchResult): unknown {
  if (!result.ok || result.notModified === true) {
    throw new Error(`expected data, got ${JSON.stringify(result)}`);
  }
  return result.data;
}

type Card = { id: string; title: string };

/** A service whose `list` query shares as told, and waits on a gate per run. */
function sharing(share: "caller" | "all", ttlMs?: number) {
  const runs: Deferred<Card[]>[] = [];
  const signals: AbortSignal[] = [];
  const handler = vi.fn(({ ctx }: { readonly ctx: { readonly signal: AbortSignal } }) => {
    const run = deferred<Card[]>();
    runs.push(run);
    signals.push(ctx.signal);
    return run.promise;
  });
  const service = qd.defineService(task, {
    methods: {
      ...taskDefaults,
      list:
        ttlMs === undefined
          ? { access: "public", share, handler }
          : { access: "public", share, ttlMs, handler },
    },
  });
  return { service, runs, signals, handler };
}

const cards: Card[] = [{ id: "t1", title: "a card" }];

describe('share: "caller"', () => {
  it("runs once for identical concurrent calls of one principal", async () => {
    const { service, runs, handler } = sharing("caller");
    const { call, records } = setup([service]);
    const first = call({ method: "list", input: { projectId: "p1", limit: 2 } });
    const second = call({ method: "list", input: { limit: 2, projectId: "p1" } });
    const defaulted = call({ method: "list", input: { projectId: "p1" } });
    await tick();
    runs[0]?.resolve(cards);
    const results = await Promise.all([first, second, defaulted]);
    expect(results).toEqual([
      { ok: true, data: cards },
      { ok: true, data: cards },
      { ok: true, data: cards },
    ]);
    expect(handler).toHaveBeenCalledOnce();
    expect(records.filter((record) => record.shared)).toHaveLength(2);
  });

  it("runs once per principal, and once per distinct input", async () => {
    const { service, runs, handler } = sharing("caller");
    const { call } = setup([service]);
    const calls = [
      call({ method: "list", input: { projectId: "p1" } }),
      call({ method: "list", input: { projectId: "p1" }, principal: bob }),
      call({ method: "list", input: { projectId: "p2" } }),
      call({
        method: "list",
        input: { projectId: "p1" },
        principal: granted(alice, { taskService: "Read" }),
      }),
    ];
    await tick();
    for (const run of runs) {
      run.resolve(cards);
    }
    expect((await Promise.all(calls)).map(codeOf)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(handler).toHaveBeenCalledTimes(4);
  });

  it("runs once per MCP context too, so a scoped token never joins another session's run", async () => {
    const { service, runs, handler } = sharing("caller");
    const { call } = setup([service]);
    const list = (mcp?: { readonly scopes: readonly string[] }) =>
      call({ method: "list", input: { projectId: "p1" }, transport: "mcp", mcp });
    const calls = [
      list({ scopes: ["read"] }),
      list({ scopes: ["read"] }),
      list({ scopes: ["read", "write"] }),
      list(),
    ];
    await tick();
    for (const run of runs) {
      run.resolve(cards);
    }
    expect((await Promise.all(calls)).map(codeOf)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  /** A `"caller"` query whose result depends on what the principal's `can` says. */
  function secrets() {
    const handler = vi.fn(async ({ ctx }: { readonly ctx: { readonly principal: unknown } }) => {
      await tick(10);
      const principal = ctx.principal as { can(scope: string): boolean };
      return principal.can("read:secrets") ? [{ id: "s1", title: "TOP SECRET" }] : [];
    });
    const service = qd.defineService(task, {
      methods: { ...taskDefaults, list: { access: "authenticated", share: "caller", handler } },
    });
    return { service, handler };
  }

  it("never shares between principals that differ only in a function member", async () => {
    const { service, handler } = secrets();
    const { call } = setup([service]);
    const full = { ...alice, can: () => true };
    const scoped = { ...alice, can: (scope: string) => scope !== "read:secrets" };
    const [first, second] = await Promise.all([
      call({ method: "list", input: { projectId: "p1" }, principal: full }),
      call({ method: "list", input: { projectId: "p1" }, principal: scoped }),
    ]);
    expect(dataOf(first)).toEqual([{ id: "s1", title: "TOP SECRET" }]);
    expect(dataOf(second)).toEqual([]);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("never shares a principal with toJSON, which could leave its claims out", async () => {
    class Session {
      constructor(
        readonly userId: string,
        readonly kind: "user",
        private readonly scopes: readonly string[],
      ) {}
      can(scope: string): boolean {
        return this.scopes.includes(scope);
      }
      toJSON(): unknown {
        return { userId: this.userId, kind: this.kind };
      }
    }
    const { service, handler } = secrets();
    const { call, records } = setup([service]);
    const full = new Session("alice", "user", ["read:secrets"]);
    const results = await Promise.all([
      call({ method: "list", input: { projectId: "p1" }, principal: full }),
      call({ method: "list", input: { projectId: "p1" }, principal: full }),
      call({
        method: "list",
        input: { projectId: "p1" },
        principal: new Session("alice", "user", []),
      }),
    ]);
    expect(results.map((result) => (dataOf(result) as Card[]).length)).toEqual([1, 1, 0]);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(records.every((record) => !record.shared)).toBe(true);
  });

  it("never shares one principal's calls over two transports", async () => {
    const { service, runs, handler } = sharing("caller");
    const { call } = setup([service]);
    const list = (transport: "socket" | "mcp" | "internal") =>
      call({ method: "list", input: { projectId: "p1" }, transport });
    const calls = [list("socket"), list("socket"), list("mcp"), list("internal")];
    await tick();
    for (const run of runs) {
      run.resolve(cards);
    }
    expect((await Promise.all(calls)).map(codeOf)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(handler).toHaveBeenCalledTimes(3);
  });
});

describe('share: "all"', () => {
  it("runs once for identical concurrent calls of different principals", async () => {
    const { service, runs, handler } = sharing("all");
    const { call } = setup([service]);
    const calls = [
      call({ method: "list", input: { projectId: "p1" } }),
      call({ method: "list", input: { projectId: "p1" }, principal: bob }),
      call({ method: "list", input: { projectId: "p1" }, principal: null }),
    ];
    await tick();
    runs[0]?.resolve(cards);
    expect((await Promise.all(calls)).map(codeOf)).toEqual(["ok", "ok", "ok"]);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("authorizes every caller before it joins, and keeps bad input out", async () => {
    const handler = vi.fn(() => tick(10).then(() => cards));
    const service = qd.defineService(task, {
      methods: { ...taskDefaults, list: { access: { service: "Read" }, share: "all", handler } },
    });
    const { call } = setup([service]);
    const reader = granted(alice, { taskService: "Read" });
    const calls = [
      call({ method: "list", input: { projectId: "p1" }, principal: reader }),
      call({ method: "list", input: { projectId: "p1" }, principal: bob }),
      call({ method: "list", input: { projectId: "p1" }, principal: null }),
      call({ method: "list", input: { projectId: "p1", limit: -1 }, principal: reader }),
      call({
        method: "list",
        input: { projectId: "p1" },
        principal: granted(bob, { taskService: "Admin" }),
      }),
    ];
    expect((await Promise.all(calls)).map(codeOf)).toEqual([
      "ok",
      "FORBIDDEN",
      "UNAUTHENTICATED",
      "VALIDATION",
      "ok",
    ]);
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("errors, cancellation and ttlMs", () => {
  it("hands an error to every sharer and never keeps it", async () => {
    const { service, runs, handler } = sharing("all", 1_000);
    const { call } = setup([service]);
    const calls = [
      call({ method: "list", input: { projectId: "p1" } }),
      call({ method: "list", input: { projectId: "p1" }, principal: bob }),
    ];
    await tick();
    runs[0]?.reject(new QuickdrawError("NOT_FOUND", "No such project"));
    const results = await Promise.all(calls);
    expect(results.map((result) => !result.ok && result.error.message)).toEqual([
      "No such project",
      "No such project",
    ]);
    const retry = call({ method: "list", input: { projectId: "p1" } });
    await tick();
    runs[1]?.resolve(cards);
    expect(await retry).toEqual({ ok: true, data: cards });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("reuses a result for ttlMs after its run, then runs again", async () => {
    const { service, runs, handler } = sharing("caller", 30);
    const { call, records } = setup([service]);
    const first = call({ method: "list", input: { projectId: "p1" } });
    await tick();
    runs[0]?.resolve(cards);
    await first;
    expect(await call({ method: "list", input: { projectId: "p1" } })).toEqual({
      ok: true,
      data: cards,
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(records[1]?.shared).toBe(true);
    await tick(40);
    const later = call({ method: "list", input: { projectId: "p1" } });
    await tick();
    runs[1]?.resolve([]);
    expect(await later).toEqual({ ok: true, data: [] });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("cancels one sharer alone, and aborts the run only when every sharer has cancelled", async () => {
    const { service, runs, signals } = sharing("all");
    const { call } = setup([service]);
    const list = (signal: AbortSignal) =>
      call({ method: "list", input: { projectId: "p1" }, signal });
    const leaving = new AbortController();
    const first = list(leaving.signal);
    const second = list(new AbortController().signal);
    const third = list(new AbortController().signal);
    await tick();
    leaving.abort();
    expect(codeOf(await first)).toBe("CANCELLED");
    expect(signals[0]?.aborted).toBe(false);
    runs[0]?.resolve(cards);
    expect((await Promise.all([second, third])).map(codeOf)).toEqual(["ok", "ok"]);

    const again = [new AbortController(), new AbortController()];
    const pending = again.map((controller) =>
      call({ method: "list", input: { projectId: "p1" }, signal: controller.signal }),
    );
    await tick();
    for (const controller of again) {
      controller.abort();
    }
    expect((await Promise.all(pending)).map(codeOf)).toEqual(["CANCELLED", "CANCELLED"]);
    expect(signals[1]?.aborted).toBe(true);
    const fresh = call({ method: "list", input: { projectId: "p1" } });
    await tick();
    expect(runs).toHaveLength(3);
    runs[2]?.resolve(cards);
    expect(codeOf(await fresh)).toBe("ok");
  });
});

describe("a shared run's copies", () => {
  const tiered = defineContract("tieredService", {
    entity: z.object({ id: z.string(), notes: z.string() }),
    fields: { notes: "Admin" },
    methods: { list: query({ input: z.object({}), output: listOf("entity") }) },
  });

  it("are one per group of callers who see the same fields, handed to respond with JSON written once", async () => {
    const opened = deferred();
    const service = qd.defineService(tiered, {
      methods: {
        list: {
          access: "authenticated",
          share: "all",
          handler: async () => {
            await opened.promise;
            return [{ id: "r1", notes: "n" }];
          },
        },
      },
    });
    const { call } = setup([service]);
    const handed: (SharedData | undefined)[] = [];
    const respond = (_result: DispatchResult, shared?: SharedData): undefined => {
      handed.push(shared);
      return undefined;
    };
    const admin = granted(alice, { tieredService: "Admin" });
    const calls = [alice, admin, bob, admin].map(
      async (principal) =>
        await call({ service: "tieredService", method: "list", input: {}, principal, respond }),
    );
    await tick();
    opened.resolve();
    const data = (await Promise.all(calls)).map(dataOf);
    expect(data).toEqual([
      [{ id: "r1" }],
      [{ id: "r1", notes: "n" }],
      [{ id: "r1" }],
      [{ id: "r1", notes: "n" }],
    ]);
    expect(data[2]).toBe(data[0]);
    expect(data[3]).toBe(data[1]);
    expect(Object.isFrozen(data[0])).toBe(true);
    expect(handed.map((shared) => shared?.data)).toEqual(data);
    expect(handed[2]).toBe(handed[0]);
    const stringify = vi.spyOn(JSON, "stringify");
    const texts = handed.map((shared) => shared?.json());
    expect(stringify).toHaveBeenCalledTimes(2);
    stringify.mockRestore();
    expect(texts).toEqual(data.map((value) => JSON.stringify(value)));
  });

  it("are not made for a call that runs unshared", async () => {
    const handed: (SharedData | undefined)[] = [];
    const respond = (_result: DispatchResult, shared?: SharedData): undefined => {
      handed.push(shared);
      return undefined;
    };
    const service = qd.defineService(tiered, {
      methods: { list: { access: "authenticated", handler: () => [{ id: "r1", notes: "n" }] } },
    });
    const { call } = setup([service]);
    await call({ service: "tieredService", method: "list", input: {}, respond });
    expect(handed).toEqual([undefined]);
  });
});

describe("shared results", () => {
  it("are frozen in development, and left alone when freezing is off", async () => {
    const list = vi.fn(() => [{ id: "t1", title: "a card" }]);
    const service = qd.defineService(task, {
      methods: {
        ...taskDefaults,
        list: { access: "public", share: "caller", handler: list },
        find: { access: "public", handler: () => null },
      },
    });
    const frozen = dataOf(
      await setup([service]).call({ method: "list", input: { projectId: "p1" } }),
    );
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen((frozen as Card[])[0])).toBe(true);
    const thawed = dataOf(
      await setup([service], { freezeSharedResults: false }).call({
        method: "list",
        input: { projectId: "p1" },
      }),
    );
    expect(Object.isFrozen(thawed)).toBe(false);
  });

  it("are not frozen for a method that does not share", async () => {
    const service = qd.defineService(task, {
      methods: {
        ...taskDefaults,
        list: { access: "public", handler: () => [{ id: "t1", title: "x" }] },
      },
    });
    const result = dataOf(
      await setup([service]).call({ method: "list", input: { projectId: "p1" } }),
    );
    expect(Object.isFrozen(result)).toBe(false);
  });
});
