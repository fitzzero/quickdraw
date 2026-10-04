// A live entity's merge rules (RFC 0003 section 6): frames and subscribe
// replies apply by revision per row, never by arrival order.

import { describe, expect, it } from "vitest";
import type { EntityFrame, EntityResult } from "../../protocol/envelope";
import {
  EMPTY_ENTITY,
  applyEntityFrame,
  applyEntityResult,
  entityResultOf,
  heldRevision,
  isEntityFrame,
  revokedEntity,
  type EntityEntry,
} from "./entities";

interface Task {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

const task = (title: string, status = "open"): Task => ({ id: "t1", title, status });

function frame(t: "u" | "p" | "r", rev: number, d?: Partial<Task>): EntityFrame<Task> {
  if (t === "r") {
    return { t, s: "taskService", id: "t1", rev };
  }
  return t === "u"
    ? { t, s: "taskService", id: "t1", rev, d: d as Task }
    : { t, s: "taskService", id: "t1", rev, d: d ?? {} };
}

function held(data: Task | undefined, rev: number): EntityEntry<Task> {
  return { ...EMPTY_ENTITY, data, rev };
}

describe("entity frames", () => {
  it("replaces the row with a newer u, and ignores an older one", () => {
    const { entry } = applyEntityFrame(held(task("A"), 100), frame("u", 200, task("B")));
    expect(entry.data).toEqual(task("B"));
    expect(entry.rev).toBe(200);
    const late = applyEntityFrame(entry, frame("u", 150, task("C")));
    expect(late.entry).toBe(entry);
  });

  it("merges a newer p into the row, ignores an older one, and asks for a row it does not hold", () => {
    const { entry } = applyEntityFrame(held(task("A"), 100), frame("p", 200, { title: "B" }));
    expect(entry.data).toEqual(task("B"));
    expect(applyEntityFrame(entry, frame("p", 150, { status: "done" })).entry).toBe(entry);
    const missing = applyEntityFrame<Task>(undefined, frame("p", 300, { title: "C" }));
    expect(missing).toEqual({ entry: EMPTY_ENTITY, request: true });
  });

  it("leaves a tombstone for r that an older u cannot clear, and a newer u can", () => {
    const { entry: removed } = applyEntityFrame(held(task("A"), 100), frame("r", 300));
    expect(removed).toMatchObject({ data: undefined, rev: 300, removed: true });
    expect(applyEntityFrame(removed, frame("u", 250, task("B"))).entry).toBe(removed);
    expect(applyEntityFrame(removed, frame("p", 250, { title: "B" })).entry).toBe(removed);
    const back = applyEntityFrame(removed, frame("u", 400, task("C")));
    expect(back.entry).toMatchObject({ data: task("C"), rev: 400, removed: false });
    // A newer patch for a removed row asks for the row: it was made again.
    expect(applyEntityFrame(removed, frame("p", 400, { title: "D" })).request).toBe(true);
  });

  it("applies frames of equal revision in the order they arrive", () => {
    const { entry } = applyEntityFrame(held(task("A"), 100), frame("p", 100, { title: "B" }));
    expect(entry.data).toEqual(task("B"));
  });
});

describe("subscribe replies", () => {
  const row = (title: string, rev: number): EntityResult<Task> => ({
    ok: true,
    d: task(title),
    rev,
  });

  it("keeps a row newer than a reply that was read before it", () => {
    const { entry } = applyEntityFrame(held(task("A"), 100), frame("p", 300, { title: "B" }));
    expect(applyEntityResult(entry, row("old", 250), 1).entry).toBe(entry);
    const fresh = applyEntityResult(entry, row("C", 300), 2).entry;
    expect(fresh).toMatchObject({ data: task("C"), rev: 300, readAt: 2 });
  });

  it("keeps the row on not modified, and asks for it when none is held any more", () => {
    const entry = held(task("A"), 100);
    expect(applyEntityResult(entry, { ok: true, nm: true, rev: 500 }, 1).entry).toBe(entry);
    expect(applyEntityResult<Task>(EMPTY_ENTITY, { ok: true, nm: true, rev: 500 }, 1).request).toBe(
      true,
    );
  });

  it("removes a row the server does not have, and drops the row on FORBIDDEN", () => {
    const missing = applyEntityResult(
      held(task("A"), 100),
      {
        ok: false,
        e: { code: "NOT_FOUND", message: "No such row" },
      },
      1,
    ).entry;
    expect(missing).toMatchObject({ data: undefined, removed: true, error: null });
    const refused = applyEntityResult(
      held(task("A"), 100),
      {
        ok: false,
        e: { code: "FORBIDDEN", message: "Insufficient permissions" },
      },
      1,
    ).entry;
    expect(refused.data).toBeUndefined();
    expect(refused.error?.code).toBe("FORBIDDEN");
  });

  it("takes a reply over a revoked entry, which holds no row, whatever their revisions", () => {
    const revoked = revokedEntity(held(task("A"), 300));
    expect(revoked.error?.code).toBe("FORBIDDEN");
    expect(applyEntityResult(revoked, row("B", 200), 1).entry).toMatchObject({
      data: task("B"),
      error: null,
    });
  });
});

describe("wire checks", () => {
  it("sends the revision held only for a row it holds", () => {
    expect(heldRevision(held(task("A"), 100))).toBe(100);
    expect(heldRevision({ ...EMPTY_ENTITY, rev: 300, removed: true })).toBeNull();
    expect(heldRevision(undefined)).toBeNull();
  });

  it("checks frames and results, which come over the network", () => {
    expect(isEntityFrame(frame("u", 1, task("A")))).toBe(true);
    expect(isEntityFrame({ t: "p", s: "taskService", id: "t1", rev: 1, d: "x" })).toBe(false);
    expect(isEntityFrame({ t: "u", s: "taskService", id: "t1", rev: "1", d: {} })).toBe(false);
    expect(entityResultOf({ ok: true, rev: 1 })).toMatchObject({
      ok: false,
      e: { code: "INTERNAL" },
    });
    expect(entityResultOf({ ok: true, nm: true, rev: 1 })).toEqual({ ok: true, nm: true, rev: 1 });
  });
});
