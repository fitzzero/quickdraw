// A failed auth route's answer and log (`failRoute`): `INTERNAL` with the
// generic message, and a log of the error's text, a Prisma error summarized
// rather than the call its message renders (the 5.1 audit's CLIENT-5).

import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { INTERNAL_MESSAGE } from "../../../protocol/errors";
import { captureLogger } from "../../__tests__/fixtures";
import { failRoute, type AuthRouteRequest } from "./respond";

/** A response that records what the route wrote. */
function response() {
  const headers = new Map<string, unknown>();
  let body = "";
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: unknown) => headers.set(name.toLowerCase(), value),
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    end: (text: string) => {
      body = text;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    headers,
    body: () => body,
    status: () => res.statusCode,
  };
}

describe("failRoute", () => {
  it("answers INTERNAL and logs a Prisma error's summary, never the values its message renders", () => {
    const logger = captureLogger();
    const out = response();
    const error = Object.assign(
      new Error(
        'Invalid `prisma.session.create()` invocation:\n\n{ data: { token: "secret-token" } }\n\nUnknown argument `token`.',
      ),
      { name: "PrismaClientValidationError" },
    );
    failRoute(logger, { url: "/auth/guest" } as AuthRouteRequest, out.res, error);
    expect(out.status()).toBe(500);
    expect(JSON.parse(out.body())).toEqual({ error: "INTERNAL", message: INTERNAL_MESSAGE });
    expect(logger.at("error")).toEqual([
      {
        level: "error",
        message: "An auth route failed",
        meta: {
          category: "quickdraw.auth",
          path: "/auth/guest",
          error: "PrismaClientValidationError: Unknown argument `token`.",
        },
      },
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain("secret-token");
  });
});
