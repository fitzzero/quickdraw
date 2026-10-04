// A service for the transport tests: it echoes who called and how, fails with
// any error code on request (or with a code no version knows), waits on gates
// the test opens, returns values that cannot be encoded, and has a method
// that needs a Moderate grant.

import { z } from "zod";
import {
  ERROR_CODES,
  QuickdrawError,
  defineContract,
  mutation,
  query,
  type ErrorCode,
} from "../../../index";
import { deferred, qd, type Deferred } from "../../__tests__/fixtures";

export const probe = defineContract("probeService", {
  methods: {
    echo: query({
      input: z.object({ text: z.string() }),
      output: z.object({
        text: z.string(),
        userId: z.string().nullable(),
        transport: z.string(),
        grants: z.record(z.string(), z.string()).nullable(),
      }),
    }),
    fail: query({ input: z.object({ code: z.enum(ERROR_CODES) }), output: z.null() }),
    /** Throws a `QuickdrawError` whose code is not one of ERROR_CODES, as a cast or a 4.x port can. */
    failOddly: mutation({
      input: z.object({ code: z.union([z.string(), z.number()]) }),
      output: z.null(),
    }),
    wait: query({ input: z.object({ key: z.string() }), output: z.string() }),
    unencodable: query({ input: z.undefined(), output: z.unknown() }),
    moderate: mutation({ input: z.object({ value: z.number() }), output: z.number() }),
  },
});

/** The probe service, with the gates its `wait` calls block on and the signals they received. */
export function createProbe() {
  const gates = new Map<string, Deferred<string>>();
  const signals = new Map<string, AbortSignal>();
  const service = qd.defineService(probe, {
    methods: {
      echo: {
        access: "public",
        handler: ({ input, ctx }) => ({
          text: input.text,
          userId: ctx.principal?.userId ?? null,
          transport: ctx.transport,
          grants: ctx.principal?.serviceAccess ?? null,
        }),
      },
      fail: {
        access: "public",
        handler: ({ input }) => {
          const data = input.code === "RATE_LIMITED" ? { retryAfterMs: 1500 } : undefined;
          throw new QuickdrawError(input.code, `Failed with ${input.code}`, data);
        },
      },
      failOddly: {
        access: "public",
        handler: ({ input }) => {
          throw new QuickdrawError(input.code as ErrorCode, `Failed with ${input.code}`);
        },
      },
      wait: {
        access: "authenticated",
        handler: ({ input, ctx }) => {
          const gate = deferred<string>();
          gates.set(input.key, gate);
          signals.set(input.key, ctx.signal);
          return gate.promise;
        },
      },
      unencodable: { access: "public", handler: () => ({ big: 10n }) },
      moderate: { access: { service: "Moderate" }, handler: ({ input }) => input.value * 2 },
    },
  });
  return { service, gates, signals };
}
