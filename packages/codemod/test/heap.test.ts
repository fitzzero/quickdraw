// The heap the command runs with (src/heap.ts): on an app of more than 1,500
// source files it starts again with three quarters of the memory it may use,
// at most 16 GiB, unless the heap is that large already, the user named one,
// it runs under Bun, or it is the relaunched process. `--heap` always wins.
// Also counts an app's source files the way the project loads them.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  availableMemory,
  exitCode,
  exitNote,
  type HeapFacts,
  heapToUse,
  MAX_HEAP,
  namesHeap,
  targetHeap,
} from "../src/heap";
import { findLayout } from "../src/layout";
import { countSourceFiles } from "../src/project";
import { PACKAGE } from "./helpers";

const GIB = 1024 ** 3;

const LARGE: HeapFacts = {
  files: 4270,
  limit: 2144,
  constrained: 0,
  total: 14 * GIB,
  requested: undefined,
  explicit: false,
  bun: false,
  relaunched: false,
};

describe("the heap", () => {
  it("reads the cgroup's limit when there is one, else the machine's memory", () => {
    expect(availableMemory(13 * GIB, 94 * GIB)).toBe(13 * GIB);
    expect(availableMemory(0, 94 * GIB)).toBe(94 * GIB);
    // an unlimited cgroup reports a huge number
    expect(availableMemory(2 ** 64, 94 * GIB)).toBe(94 * GIB);
  });

  it("is three quarters of the memory, at most 16 GiB", () => {
    expect(targetHeap(14 * GIB)).toBe(10_752);
    expect(targetHeap(8 * GIB)).toBe(6144);
    expect(targetHeap(64 * GIB)).toBe(MAX_HEAP);
  });

  it("is raised on a large app whose heap is smaller", () => {
    expect(heapToUse(LARGE)).toBe(10_752);
    expect(heapToUse({ ...LARGE, constrained: 8 * GIB })).toBe(6144);
    expect(heapToUse({ ...LARGE, total: 128 * GIB })).toBe(MAX_HEAP);
  });

  it("is kept on a small app, or when it is that large already", () => {
    expect(heapToUse({ ...LARGE, files: 1500 })).toBeUndefined();
    expect(heapToUse({ ...LARGE, limit: 10_800 })).toBeUndefined();
    // a small machine's default heap is larger than three quarters of it
    expect(heapToUse({ ...LARGE, total: 2 * GIB })).toBeUndefined();
  });

  it("is kept when the user named one, under Bun, and in the relaunched process", () => {
    expect(heapToUse({ ...LARGE, explicit: true })).toBeUndefined();
    expect(heapToUse({ ...LARGE, bun: true })).toBeUndefined();
    expect(heapToUse({ ...LARGE, relaunched: true })).toBeUndefined();
    expect(heapToUse({ ...LARGE, bun: true, requested: 4096 })).toBeUndefined();
    expect(heapToUse({ ...LARGE, relaunched: true, requested: 4096 })).toBeUndefined();
  });

  it("is --heap when it is passed, on any app", () => {
    expect(heapToUse({ ...LARGE, requested: 4096 })).toBe(4096);
    expect(heapToUse({ ...LARGE, files: 10, requested: 4096 })).toBe(4096);
    expect(heapToUse({ ...LARGE, explicit: true, requested: 24_576 })).toBe(24_576);
  });

  it("finds a heap the user passed to node", () => {
    expect(namesHeap(["--max-old-space-size=8192"])).toBe(true);
    expect(namesHeap(["--max_old_space_size", "8192"])).toBe(true);
    expect(namesHeap(["--max-semi-space-size=64", ""])).toBe(false);
  });

  it("passes the relaunched command's exit code on, and explains a kill", () => {
    expect(exitCode(0, undefined)).toBe(0);
    expect(exitCode(1, undefined)).toBe(1);
    expect(exitCode(null, 9)).toBe(137);
    expect(exitNote(8192, null, "SIGKILL")).toMatch(
      /^quickdraw-codemod: the system stopped the command \(SIGKILL\) with a 8192 MiB heap, most likely because the machine ran out of memory: pass a smaller --heap/u,
    );
    expect(exitNote(8192, 134, null)).toMatch(
      /ran out of its 8192 MiB heap: pass a larger --heap/u,
    );
    expect(exitNote(8192, 1, null)).toBeUndefined();
    expect(exitNote(8192, null, "SIGINT")).toBeUndefined();
  });
});

describe("the source file count", () => {
  const root = join(PACKAGE, ".test-output", `count-${String(process.pid)}`);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("counts the .ts and .tsx files the project loads, skipping what it skips", () => {
    const files = [
      "packages/shared/src/index.ts",
      "packages/shared/src/types.d.ts",
      "apps/api/src/index.ts",
      "apps/api/src/services/a.ts",
      "apps/api/src/generated/client.ts",
      "apps/api/src/node_modules/x/index.ts",
      "apps/api/src/notes.md",
      "apps/web/src/App.tsx",
      "apps/web/src/dist/App.js",
      "apps/web/src/.next/page.tsx",
    ];
    for (const file of files) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), "");
    }
    expect(countSourceFiles(findLayout(root))).toBe(4);
  });
});
