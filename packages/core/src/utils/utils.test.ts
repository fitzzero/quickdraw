// The isomorphic `./utils` entry: the 4.1 helpers it carries over unchanged
// (the formatting checks were only respelled for `eqeqeq`), and the server
// caller and keys it shares with `./client`.

import { describe, expect, it } from "vitest";
import * as client from "../client/index";
import * as utils from "./index";

describe("./utils", () => {
  it("formats null and undefined as a dash, and zero as a value", () => {
    for (const empty of [null, undefined]) {
      expect(utils.formatCurrency(empty)).toBe("-");
      expect(utils.formatNumber(empty)).toBe("-");
      expect(utils.formatPercent(empty)).toBe("-");
    }
    expect(utils.formatCurrency(0)).toBe("$0.00");
    expect(utils.formatNumber("1234.5")).toBe("1,234.5");
    expect(utils.formatPercent(12.345)).toBe("12.3%");
    expect(utils.formatCurrency("not a number")).toBe("-");
  });

  it("reads a JWT's payload without verifying it", () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = `${encode({ alg: "none" })}.${encode({ userId: "u1", email: "u@x.io" })}.sig`;
    expect(utils.parseJWTPayload(token)).toEqual({ userId: "u1", email: "u@x.io" });
    expect(utils.parseJWTPayload("not.a.jwt")).toBeNull();
    expect(utils.parseJWTPayload(`${encode({})}.${encode({ id: 1 })}.sig`)).toBeNull();
  });

  it("reads a payload whose base64url has - and _ and no padding, as UTF-8", () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const payload = { userId: "u10??>>", email: "é10@example.com" };
    const segment = encode(payload);
    expect(segment).toContain("-");
    expect(segment).toContain("_");
    expect(segment.length % 4).not.toBe(0);
    expect(utils.parseJWTPayload(`${encode({ alg: "none" })}.${segment}.sig`)).toEqual(payload);
  });

  it("is re-exported whole by ./client", () => {
    for (const [name, value] of Object.entries(utils)) {
      expect((client as Record<string, unknown>)[name]).toBe(value);
    }
    expect(Object.keys(utils).sort()).toEqual(
      [
        "KEY_ROOT",
        "buildBreadcrumbs",
        "collectionKey",
        "createServerCaller",
        "entityKey",
        "findNavItemByHref",
        "findParentNavItem",
        "formatCurrency",
        "formatDate",
        "formatDateTime",
        "formatNumber",
        "formatPercent",
        "methodKey",
        "methodKeyPrefix",
        "parseJWTPayload",
        "routeRequiresAuth",
        "serviceKeyPrefix",
        "truncate",
      ].sort(),
    );
  });
});
