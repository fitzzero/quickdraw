// The access mapping's mirror of 5.x's rowless refusal (src/access.ts): a
// method whose input has `id`, on a service with rows, carries `rowless:
// true` (marked) where its form asks the policy nothing about the row id
// names. A `resolveEntryId` that named another key writes `{ service, entry,
// id: "<key>" }`, which checks that key's row: 5.x refuses it without the
// flag.

import { describe, expect, it } from "vitest";
import { accessFor, type MethodFacts } from "../src/access";

/** What the mapping knows of a method that named `key` with its `resolveEntryId`. */
const keyed = (key: string, facts: Partial<MethodFacts> = {}): MethodFacts => ({
  entryId: { kind: "key", key },
  rows: true,
  inputHasId: true,
  ...facts,
});

describe("accessFor's rowless flag", () => {
  it("marks an entry form on another key of an input that has id", () => {
    const form = accessFor("Read", '"Read"', keyed("chatId"));
    expect(form.code).toBe('{ service: "Read", entry: "Read", id: "chatId" }');
    expect(form.rowless).toBe(true);
    const note = form.notes.find((each) => each.message.includes("chatId"));
    expect(note?.category).toBe("access");
    expect(note?.message).toContain(
      "checks the row its chatId names (4.x's resolveEntryId), not the row id names",
    );
  });

  it("leaves it alone without an id in the input, on id itself, or without rows", () => {
    for (const facts of [
      keyed("chatId", { inputHasId: false }),
      keyed("id"),
      keyed("chatId", { rows: false }),
    ]) {
      const form = accessFor("Read", '"Read"', facts);
      expect(form.rowless, JSON.stringify(facts)).toBe(false);
      expect(
        form.notes.some((each) => each.message.includes("rowless")),
        JSON.stringify(facts),
      ).toBe(false);
    }
  });

  it("still marks a form that checks no row on an input that has id", () => {
    const form = accessFor("Public", '"Public"', keyed("chatId"));
    expect(form.code).toBe('"public"');
    expect(form.rowless).toBe(true);
    expect(form.notes).toHaveLength(1);
  });
});
