// The live stores' seam (RFC 0003 section 11.5) needs neither TanStack Query
// nor React: `host.ts` (the `LiveCache` and `LiveOverlays` the stores work
// over), `stores.ts` (the stores, and what the connection's life does to
// them) and `../cacheSession.ts` (what each hello does to a cache). None of
// them imports either, not even a type, and nothing they load at run time
// does, so stores over a cache of their own run where neither is installed.
// `queryCache.ts` and `liveData.ts`, the `QueryClient`'s side, are left out.

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-query", () => {
  throw new Error("@tanstack/react-query was loaded");
});
vi.mock("@tanstack/query-core", () => {
  throw new Error("@tanstack/query-core was loaded");
});
vi.mock("react", () => {
  throw new Error("react was loaded");
});
// Loaded by their own names, not through `react`'s: each is refused on its own.
vi.mock("react/jsx-runtime", () => {
  throw new Error("react/jsx-runtime was loaded");
});
vi.mock("react/jsx-dev-runtime", () => {
  throw new Error("react/jsx-dev-runtime was loaded");
});
vi.mock("react-dom", () => {
  throw new Error("react-dom was loaded");
});
vi.mock("react-dom/client", () => {
  throw new Error("react-dom/client was loaded");
});

const SEAM = ["./host.ts", "./stores.ts", "../cacheSession.ts"];

/** What a module's import and export statements name, bare imports (`import "x"`) included. */
function specifiers(path: string): string[] {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  return [
    ...source.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"|^import\s+"([^"]+)"/gmu),
  ].map((match) => match[1] ?? match[2] ?? "");
}

describe("the live stores' seam", () => {
  it.each(SEAM)("%s imports nothing from TanStack Query or React", (path) => {
    const named = specifiers(path);
    expect(named.length).toBeGreaterThan(0);
    expect(
      named.filter((specifier) => /^(@tanstack\/|react(-dom)?(\/|$))/u.test(specifier)),
    ).toEqual([]);
  });

  it("loads with neither TanStack Query nor React", async () => {
    const host = await import("./host");
    const stores = await import("./stores");
    const session = await import("../cacheSession");
    expect(typeof host.readEntry).toBe("function");
    expect(typeof stores.createStores).toBe("function");
    expect(typeof stores.followConnection).toBe("function");
    expect(typeof session.cacheSessionOf).toBe("function");
  });
});
