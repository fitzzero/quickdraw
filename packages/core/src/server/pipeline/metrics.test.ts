// What a failure's log holds (the 5.1 audit's CLIENT-5): a Prisma error's
// message renders the call it failed, values included, so `describeError`
// and `errorText` summarize it (class, code, `meta` without the database's
// own text, the reason a validation error gives, stack frames) and keep
// every other error whole. The audit's PoC E runs against the PGlite
// harness: a create with an unknown argument logged an email and a password.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { errorText } from "../../contract/logger";
import { toQuickdrawError } from "./errors";
import { describeError } from "./metrics";

const EMAIL = "alice@example.com";
const SECRET = "hunter2-secret";

/** An error shaped as the Prisma client's `name` error is, with `fields` on it. */
function prismaError(name: string, message: string, fields: Record<string, unknown> = {}): Error {
  const error = Object.assign(new Error(message), fields);
  error.name = name;
  error.stack = `${name}: ${message}\n    at create (node_modules/@prisma/client/runtime.js:1:1)\n    at handler (src/services/users.ts:9:5)`;
  return error;
}

const RENDERED = [
  "",
  "Invalid `prisma.user.create()` invocation:",
  "",
  "{",
  "  data: {",
  `    email: "${EMAIL}",`,
  `    passwordPlain: "${SECRET}"`,
  "    ~~~~~~~~~~~~~",
  "  }",
  "}",
  "",
  "Unknown argument `passwordPlain`. Available options are marked with ?.",
].join("\n");

describe("describeError", () => {
  it("summarizes a Prisma validation error: its class, reason and frames, never the values its message renders", () => {
    const error = prismaError("PrismaClientValidationError", RENDERED, { clientVersion: "6.0.0" });
    const logged = JSON.stringify(describeError(toQuickdrawError(error)));
    expect(logged).not.toContain(EMAIL);
    expect(logged).not.toContain(SECRET);
    expect(describeError(error)).toEqual({
      name: "PrismaClientValidationError",
      clientVersion: "6.0.0",
      reason: "Unknown argument `passwordPlain`. Available options are marked with ?.",
      stack:
        "    at create (node_modules/@prisma/client/runtime.js:1:1)\n    at handler (src/services/users.ts:9:5)",
    });
    expect(errorText(error)).toBe(
      "PrismaClientValidationError: Unknown argument `passwordPlain`. Available options are marked with ?.",
    );
  });

  it("keeps a known request error's code and meta, without the database's own text", () => {
    const unique = prismaError("PrismaClientKnownRequestError", RENDERED, {
      code: "P2002",
      meta: { target: ["email"], modelName: "User" },
    });
    expect(describeError(unique)).toMatchObject({
      name: "PrismaClientKnownRequestError",
      code: "P2002",
      meta: { target: ["email"], modelName: "User" },
    });
    expect(errorText(unique)).toBe("PrismaClientKnownRequestError P2002");
    const raw = prismaError("PrismaClientKnownRequestError", RENDERED, {
      code: "P2010",
      meta: { code: "23505", message: `Key (email)=(${EMAIL}) already exists.` },
    });
    const logged = JSON.stringify(describeError(raw));
    expect(logged).not.toContain(EMAIL);
    expect(describeError(raw)).toMatchObject({ code: "P2010", meta: { code: "23505" } });
  });

  it("keeps any other error whole: its message and stack", () => {
    const error = new Error(`no row for ${EMAIL}`);
    expect(describeError(error)).toMatchObject({
      name: "Error",
      message: `no row for ${EMAIL}`,
      stack: error.stack,
    });
    expect(errorText(error)).toBe(`no row for ${EMAIL}`);
    expect(errorText("plain")).toBe("plain");
  });
});

describe("a Prisma error from a real client (the audit's PoC E)", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  it("logs neither the email nor the password of a create with an unknown argument", async () => {
    const error: unknown = await h.prisma.user
      .create({ data: { email: EMAIL, name: "Alice", passwordPlain: SECRET } as never })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    for (const logged of [
      JSON.stringify(describeError(toQuickdrawError(error))),
      errorText(error),
    ]) {
      expect(logged).not.toContain(EMAIL);
      expect(logged).not.toContain(SECRET);
      expect(logged).toContain("PrismaClientValidationError");
    }
    expect(errorText(error)).toContain("passwordPlain");
  });

  it("logs no value of a unique constraint the database refused", async () => {
    await h.prisma.user.create({ data: { email: EMAIL, name: "Alice" } });
    const error: unknown = await h.prisma.user
      .create({ data: { email: EMAIL, name: "Alice again" } })
      .catch((caught: unknown) => caught);
    const logged = JSON.stringify(describeError(toQuickdrawError(error)));
    expect(logged).toContain("P2002");
    expect(logged).not.toContain(EMAIL);
    expect(errorText(error)).not.toContain(EMAIL);
  });
});
