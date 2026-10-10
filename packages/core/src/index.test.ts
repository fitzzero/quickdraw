import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { QUICKDRAW_VERSION } from "./index";

describe("QUICKDRAW_VERSION", () => {
  // One script writes the version into both places (scripts/auto-release.sh,
  // for a release that lands without a bump of its own), so this holds them to
  // each other instead of to a literal a release would have to come back for.
  it("matches the package.json version", () => {
    expect(QUICKDRAW_VERSION).toBe(packageJson.version);
  });

  it("is a version, not a placeholder", () => {
    expect(QUICKDRAW_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });
});
