import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appDir } from "./paths";

/**
 * A comparison is only fair when both apps serve the same rows: the 5.0 app
 * keeps the 4.1 app's schema, its tables and its seed byte for byte.
 */
describe("the 4.1 and 5.0 apps", () => {
  it.each([
    "prisma/schema.prisma",
    "prisma/schema.sql",
    "prisma.config.ts",
    "src/seed.ts",
    "src/db.ts",
  ])("share %s", (file) => {
    const v4 = readFileSync(join(appDir("v4"), file), "utf8");
    const v5 = readFileSync(join(appDir("v5"), file), "utf8");
    expect(v5).toBe(v4);
  });
});
