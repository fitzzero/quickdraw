import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { QUICKDRAW_VERSION } from "./index";

describe("QUICKDRAW_VERSION", () => {
  it("is the 5.0 release candidate version", () => {
    expect(QUICKDRAW_VERSION).toBe("5.0.0-rc.0");
  });

  it("matches the package.json version", () => {
    expect(QUICKDRAW_VERSION).toBe(packageJson.version);
  });
});
