// The overlay store of optimistic mutations (RFC 0003 section 11.4), without
// React: layers opened when a call is sent, dropped when it fails, kept after
// it succeeds until a newer revision or a later read of the row, stacked in
// call order, and shown only over the fields a row has.

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { QuickdrawError, listOf, nullable } from "../index";
import { deferred } from "../server/__tests__/fixtures";
import {
  mutateOptimistically,
  overlaysOf,
  rowIdsOf,
  rowShapeOf,
  showRows,
  type OptimisticTarget,
} from "./optimistic";

const task: OptimisticTarget = { service: "taskService", entityOutput: true };
const row = Object.freeze({ id: "t1", title: "T1", status: "open" });
const other = Object.freeze({ id: "t2", title: "T2", status: "open" });

/** One mutation call whose reply the test gives. */
function send(
  client: QueryClient,
  input: unknown,
  optimistic?: Parameters<typeof mutateOptimistically>[2],
) {
  const reply = deferred<unknown>();
  const call = vi.fn(() => reply.promise);
  const done = mutateOptimistically(client, task, optimistic, input, call);
  return { reply, call, done };
}

describe("a pending call", () => {
  it("shows its input's fields over the rows that have them, and only those rows", () => {
    const client = new QueryClient();
    const overlays = overlaysOf(client);
    const { call } = send(client, { id: "t1", title: "New", notify: true });
    expect(call).toHaveBeenCalledTimes(1);
    expect(overlays.applyOverlay("taskService", row)).toEqual({
      id: "t1",
      title: "New",
      status: "open",
    });
    expect(overlays.applyOverlay("taskService", other)).toBe(other);
    expect(overlays.applyOverlay("labelService", row)).toBe(row);
    expect(overlays.applyOverlay("taskService", "not a row")).toBe("not a row");
  });

  it("is dropped when the call fails", async () => {
    const client = new QueryClient();
    const overlays = overlaysOf(client);
    const { reply, done } = send(client, { id: "t1", title: "New" });
    reply.reject(new QuickdrawError("CONFLICT", "That title is taken"));
    await expect(done).rejects.toMatchObject({ code: "CONFLICT" });
    expect(overlays.applyOverlay("taskService", row)).toBe(row);
  });

  it("stacks with other calls in call order, and each is dropped with its own call", async () => {
    const client = new QueryClient();
    const overlays = overlaysOf(client);
    const first = send(client, { id: "t1", title: "First" });
    const second = send(client, { id: "t1", status: "done" });
    const third = send(client, { id: "t1", title: "Third" });
    expect(overlays.applyOverlay("taskService", row)).toEqual({
      id: "t1",
      title: "Third",
      status: "done",
    });
    third.reply.reject(new QuickdrawError("FORBIDDEN", "No"));
    await expect(third.done).rejects.toThrow("No");
    expect(overlays.applyOverlay("taskService", row)).toEqual({
      id: "t1",
      title: "First",
      status: "done",
    });
    first.reply.resolve({ ...row, title: "First" });
    second.reply.resolve({ ...row, status: "done" });
    await Promise.all([first.done, second.done]);
    expect(overlays.applyOverlay("taskService", row)).toEqual({
      id: "t1",
      title: "First",
      status: "done",
    });
  });
});

describe("a finished call", () => {
  it("keeps its layer, with the values of the reply, until a read sent after the reply", async () => {
    const client = new QueryClient();
    const overlays = overlaysOf(client);
    const { reply, done } = send(client, { id: "t1", title: "  New  " });
    const sentBefore = overlays.now();
    reply.resolve({ ...row, title: "New" });
    expect(await done).toEqual({ ...row, title: "New" });
    expect(overlays.applyOverlay("taskService", row)).toEqual({ ...row, title: "New" });
    overlays.read("taskService", ["t1"], sentBefore);
    expect(overlays.applyOverlay("taskService", row)).toEqual({ ...row, title: "New" });
    overlays.read("taskService", ["t2"], overlays.now());
    expect(overlays.applyOverlay("taskService", row)).toEqual({ ...row, title: "New" });
    overlays.read("taskService", ["t1"], overlays.now());
    expect(overlays.applyOverlay("taskService", row)).toBe(row);
  });

  it("keeps its layer until a revision newer than every one seen before the write", async () => {
    const client = new QueryClient();
    const overlays = overlaysOf(client);
    overlays.observe("taskService", "t1", 5);
    const { reply, done } = send(client, { id: "t1", title: "New" });
    // Before the reply, a frame comes from an earlier flush.
    overlays.observe("taskService", "t1", 7);
    reply.resolve({ ...row, title: "New" });
    await done;
    overlays.observe("taskService", "t1", 6);
    overlays.observe("taskService", "t1", 7);
    expect(overlays.applyOverlay("taskService", row)).toEqual({ ...row, title: "New" });
    overlays.observe("taskService", "t1", 8);
    expect(overlays.applyOverlay("taskService", row)).toBe(row);
  });

  it("with no revision seen before the write, ends at the first one after it", async () => {
    const client = new QueryClient();
    const overlays = overlaysOf(client);
    const { reply, done } = send(client, { id: "t1", title: "New" });
    reply.resolve(null);
    await done;
    overlays.observe("taskService", "t1", Number.NaN);
    expect(overlays.applyOverlay("taskService", row)).toEqual({ ...row, title: "New" });
    overlays.observe("taskService", "t1", 1);
    expect(overlays.applyOverlay("taskService", row)).toBe(row);
  });
});

describe("a custom optimistic update", () => {
  it("hides removed rows from lists and nullable results, and patches items of one collection only", async () => {
    const client = new QueryClient();
    const overlays = overlaysOf(client);
    const { reply, done } = send(client, { id: "t1" }, (input, cache) => {
      cache.removeEntity("t2");
      cache.patchItem("board", (input as { id: string }).id, { title: "On the board" });
    });
    const view = overlays.view("taskService");
    expect(showRows(view, "list", [row, other])).toEqual([row]);
    expect(showRows(view, "list", [row])).toEqual([row]);
    expect(showRows(view, "nullable", other)).toBeNull();
    expect(showRows(view, "one", other)).toBe(other);
    expect(overlays.applyOverlay("taskService", row)).toBe(row);
    expect(overlays.applyOverlay("taskService", row, "board")).toEqual({
      ...row,
      title: "On the board",
    });
    expect(overlays.applyOverlay("taskService", row, "mine")).toBe(row);
    reply.reject(new QuickdrawError("FORBIDDEN", "No"));
    await expect(done).rejects.toThrow("No");
    expect(showRows(overlays.view("taskService"), "list", [row, other])).toEqual([row, other]);
  });

  it("is used instead of the default, and a throw drops what it wrote without sending", async () => {
    const client = new QueryClient();
    const overlays = overlaysOf(client);
    const { call, done } = send(client, { id: "t1", title: "New" }, (_input, cache) => {
      cache.patchEntity("t2", { title: "Elsewhere" });
      throw new Error("the update failed");
    });
    await expect(done).rejects.toThrow("the update failed");
    expect(call).not.toHaveBeenCalled();
    expect(overlays.applyOverlay("taskService", other)).toBe(other);
  });
});

describe("calls that open no layer", () => {
  it.each([
    ["optimistic: false", { id: "t1", title: "New" }, false, task],
    ["an input without an id", { title: "New" }, undefined, task],
    [
      "an output that is not the entity",
      { id: "t1", title: "New" },
      undefined,
      { ...task, entityOutput: false },
    ],
  ] as const)("%s sends at once and shows nothing", async (_label, input, optimistic, target) => {
    const client = new QueryClient();
    const overlays = overlaysOf(client);
    const listener = vi.fn();
    overlays.subscribe(listener);
    const result = await mutateOptimistically(
      client,
      target,
      optimistic,
      input,
      async () => "sent",
    );
    expect(result).toBe("sent");
    expect(overlays.applyOverlay("taskService", row)).toBe(row);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("the store", () => {
  it("is one per QueryClient, tells subscribers of changes, and keeps a view per service until it changes", async () => {
    const client = new QueryClient();
    const overlays = overlaysOf(client);
    expect(overlaysOf(client)).toBe(overlays);
    expect(overlaysOf(new QueryClient())).not.toBe(overlays);
    const listener = vi.fn();
    const stop = overlays.subscribe(listener);
    const tasks = overlays.view("taskService");
    const labels = overlays.view("labelService");
    expect(overlays.view("taskService")).toBe(tasks);
    const { reply, done } = send(client, { id: "t1", title: "New" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(overlays.view("taskService")).not.toBe(tasks);
    expect(overlays.view("labelService")).toBe(labels);
    reply.resolve(null);
    await done;
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    overlays.read("taskService", ["t1"], overlays.now());
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps at most 1,000 layers, dropping the oldest finished ones first", async () => {
    const client = new QueryClient();
    const overlays = overlaysOf(client);
    const finished = send(client, { id: "old", title: "Finished" });
    finished.reply.resolve(null);
    await finished.done;
    const pending = send(client, { id: "pending", title: "Pending" });
    for (let index = 0; index < 999; index += 1) {
      send(client, { id: `t${index}`, title: "Many" });
    }
    expect(overlays.applyOverlay("taskService", { id: "old", title: "Old" })).toEqual({
      id: "old",
      title: "Old",
    });
    expect(overlays.applyOverlay("taskService", { id: "pending", title: "Old" })).toEqual({
      id: "pending",
      title: "Pending",
    });
    void pending;
  });
});

describe("row shapes", () => {
  it("are read from a method's output", () => {
    expect(rowShapeOf("entity")).toBe("one");
    expect(rowShapeOf("card")).toBe("one");
    expect(rowShapeOf(nullable("entity"))).toBe("nullable");
    expect(rowShapeOf(listOf("card"))).toBe("list");
    expect(rowShapeOf(z.object({ kind: z.literal("list") }))).toBeUndefined();
    expect(rowShapeOf(undefined)).toBeUndefined();
    expect(rowIdsOf("one", row)).toEqual(["t1"]);
    expect(rowIdsOf("nullable", null)).toEqual([]);
    expect(rowIdsOf("list", [row, other, 3])).toEqual(["t1", "t2"]);
    expect(rowIdsOf("list", "not a list")).toEqual([]);
  });
});
