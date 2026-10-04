// The shared development warning format (`devWarnings.ts`): one line per
// warning naming its kind and call, once per kind, service, method and
// subject; thrown instead when strict; off in production.

import { describe, expect, it } from "vitest";
import { captureLogger } from "./__tests__/fixtures";
import {
  checked,
  createDevWarnings,
  DevWarningError,
  formatDevWarning,
  isQuiet,
  quietly,
  type DevWarning,
} from "./devWarnings";

const nPlusOne: DevWarning = {
  kind: "n-plus-one",
  service: "taskService",
  method: "board",
  message: "task.findUnique by id ran 10 times in one call",
  meta: { model: "task" },
};

describe("development warnings", () => {
  it("share one format, naming the kind and the call when there is one", () => {
    expect(formatDevWarning(nPlusOne)).toBe(
      "[quickdraw:n-plus-one] taskService.board: task.findUnique by id ran 10 times in one call",
    );
    expect(
      formatDevWarning({ kind: "ambient-write", subject: "task", message: "outside any unit" }),
    ).toBe("[quickdraw:ambient-write] outside any unit");
  });

  it("are logged once per kind, service, method and subject, with their call in the meta", () => {
    const logger = captureLogger();
    const warnings = createDevWarnings({ logger, development: true });
    warnings.warn(nPlusOne);
    warnings.warn(nPlusOne);
    warnings.warn({ ...nPlusOne, method: "list" });
    warnings.warn({ ...nPlusOne, kind: "unbounded-read" });
    warnings.warn({ kind: "nested-write", subject: "task.labels.create", message: "nested" });
    warnings.warn({ kind: "nested-write", subject: "task.labels.create", message: "nested" });
    warnings.warn({ kind: "nested-write", subject: "task.subtasks.create", message: "nested" });
    expect(logger.at("warn").map((entry) => entry.message)).toEqual([
      "[quickdraw:n-plus-one] taskService.board: task.findUnique by id ran 10 times in one call",
      "[quickdraw:n-plus-one] taskService.list: task.findUnique by id ran 10 times in one call",
      "[quickdraw:unbounded-read] taskService.board: task.findUnique by id ran 10 times in one call",
      "[quickdraw:nested-write] nested",
      "[quickdraw:nested-write] nested",
    ]);
    expect(logger.at("warn")[0]?.meta).toEqual({
      category: "quickdraw.dev",
      warning: "n-plus-one",
      service: "taskService",
      method: "board",
      model: "task",
    });
  });

  it("log nothing outside development", () => {
    const logger = captureLogger();
    const warnings = createDevWarnings({ logger, development: false });
    expect(warnings.enabled).toBe(false);
    warnings.warn(nPlusOne);
    expect(logger.entries).toEqual([]);
  });

  it("throw a DevWarningError every time when strict, development or not", () => {
    const logger = captureLogger();
    const warnings = createDevWarnings({ logger, development: false, strict: true });
    expect(warnings.enabled).toBe(true);
    for (let round = 0; round < 2; round += 1) {
      const thrown: unknown = (() => {
        try {
          warnings.warn(nPlusOne);
          return undefined;
        } catch (error) {
          return error;
        }
      })();
      expect(thrown).toBeInstanceOf(DevWarningError);
      expect(thrown).toMatchObject({ name: "DevWarningError", warning: nPlusOne });
      expect((thrown as Error).message).toBe(formatDevWarning(nPlusOne));
    }
    expect(logger.entries).toEqual([]);
  });

  it("run code quietly, awaiting it inside, and nowhere else", async () => {
    expect(isQuiet()).toBe(false);
    const seen: boolean[] = [];
    const lazy: PromiseLike<string> = {
      then(onfulfilled, onrejected) {
        seen.push(isQuiet());
        return Promise.resolve("done").then(onfulfilled, onrejected);
      },
    };
    expect(await quietly(() => lazy)).toBe("done");
    expect(seen).toEqual([true]);
    expect(isQuiet()).toBe(false);
  });

  it("check the app's callbacks again inside a quiet kit handler", async () => {
    const inside = await quietly(async () => [
      isQuiet(),
      await checked(() => isQuiet()),
      await checked(async () => await quietly(() => isQuiet())),
      isQuiet(),
    ]);
    expect(inside).toEqual([true, false, true, true]);
    expect(await checked(() => isQuiet())).toBe(false);
  });
});
