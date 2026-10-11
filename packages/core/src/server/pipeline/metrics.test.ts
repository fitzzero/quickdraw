// What a failure's log holds (the 5.1 audit's CLIENT-5): a Prisma error's
// message renders the call it failed, values included, and its `meta` can
// hold the database's own text, which quotes the row (Prisma 7's
// `driverAdapterError`), so `describeError` and `errorText` summarize it
// (class, code, the schema names and codes of its `meta`, the reason a
// validation error gives, stack frames) and keep every other error whole. The audit's PoC E runs against the PGlite
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

  it("keeps the schema names of meta, and of a driver adapter's cause, never a value (Prisma 7)", () => {
    const adapterError = Object.assign(new Error("DriverAdapterError"), {
      name: "DriverAdapterError",
      cause: {
        originalCode: "23514",
        originalMessage: 'new row for relation "User" violates check constraint "name_not_bad"',
        kind: "postgres",
        code: "23514",
        severity: "ERROR",
        message: 'new row for relation "User" violates check constraint "name_not_bad"',
        detail: `Failing row contains (u1, ${EMAIL}, bad, null).`,
        cause: `value "${SECRET}"`,
      },
    });
    const check = prismaError("PrismaClientKnownRequestError", RENDERED, {
      code: "P2039",
      meta: {
        modelName: "User",
        driverAdapterError: adapterError,
        argument_value: EMAIL,
        field_value: SECRET,
        details: `value "${SECRET}" is out of range`,
      },
    });
    expect(describeError(check)).toMatchObject({
      code: "P2039",
      meta: {
        modelName: "User",
        driverAdapterError: {
          name: "DriverAdapterError",
          cause: { originalCode: "23514", kind: "postgres", code: "23514" },
        },
      },
    });
    const logged = JSON.stringify(describeError(toQuickdrawError(check)));
    expect(logged).not.toContain(EMAIL);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain("check constraint");
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

  it("logs no value of a row a check constraint refused, a value out of range, or a raw query", async () => {
    await h.prisma.$executeRawUnsafe(
      `ALTER TABLE "User" ADD CONSTRAINT name_not_bad CHECK (name <> 'bad')`,
    );
    const owner = await h.prisma.user.create({ data: { email: "owner@example.com", name: "O" } });
    const project = await h.prisma.project.create({ data: { name: "P", ownerId: owner.id } });
    const failures: unknown[] = [
      await h.prisma.user
        .create({ data: { email: `bob-${SECRET}@example.com`, name: "bad" } })
        .catch((caught: unknown) => caught),
      await h.prisma.task
        .create({ data: { projectId: project.id, title: SECRET, ordinal: 2 ** 31 } })
        .catch((caught: unknown) => caught),
      await h.prisma.$queryRaw`SELECT ${SECRET}::uuid`.catch((caught: unknown) => caught),
    ];
    for (const error of failures) {
      expect(error).toBeInstanceOf(Error);
      for (const logged of [
        JSON.stringify(describeError(toQuickdrawError(error))),
        errorText(error),
      ]) {
        expect(logged).not.toContain(SECRET);
        expect(logged).not.toContain("2147483648");
      }
    }
    expect(JSON.stringify(describeError(failures[0]))).toContain("driverAdapterError");
  });
});
