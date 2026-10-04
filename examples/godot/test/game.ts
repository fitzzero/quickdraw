// The game service the GDScript client is checked against, by the Node wire
// test (`wire.test.ts`) and by Godot itself (`godot.ts`): one world every
// player joins (an app room), a `move` channel that requires it, a typed
// `moved` event to the world, a seeded `ticks` stream, and a slow query for
// the call limits. The server runs on `createTestApp` with a short heartbeat
// and one query at a time, so a second concurrent query is RATE_LIMITED.

import { defineContract, mutation, query, QuickdrawError } from "@fitzzero/quickdraw-core";
import { initQuickdraw } from "@fitzzero/quickdraw-core/server";
import { createTestApp } from "@fitzzero/quickdraw-core/testing";
import { z } from "zod";

/** The world's app room. A game has one; `move` requires the sender's socket in it. */
export const WORLD = "world:main";

/** The tokens the server accepts: each is its user's id. Any other token is refused. */
export const TOKENS: readonly string[] = ["ada", "bo"];

const qd = initQuickdraw();

export const game = defineContract("gameService", {
  methods: {
    echo: query({
      input: z.object({ text: z.string() }),
      output: z.object({ text: z.string(), userId: z.string() }),
    }),
    wait: query({ input: z.object({ ms: z.number() }), output: z.number() }),
    join: mutation({
      input: z.object({ name: z.string() }),
      output: z.object({ players: z.array(z.string()) }),
    }),
  },
  streams: {
    ticks: { item: z.object({ n: z.number() }), seed: 2, access: "authenticated" },
  },
  channels: {
    move: { payload: z.object({ dx: z.number(), dy: z.number() }), requires: { room: WORLD } },
  },
  events: {
    moved: { payload: z.object({ userId: z.string(), dx: z.number(), dy: z.number() }) },
  },
});

/** Resolves after `ms`, or at once when the call is cancelled. */
function sleep(ms: number, signal: AbortSignal): Promise<number> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(ms);
    }, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve(0);
    });
  });
}

/** The service, with its own tick counter. */
export function gameService() {
  let ticks = 0;
  return qd.defineService(game, {
    methods: {
      echo: {
        access: "authenticated",
        handler: ({ input, ctx }) => ({ text: input.text, userId: ctx.principal.userId }),
      },
      wait: {
        access: "authenticated",
        handler: async ({ input, ctx }) => await sleep(input.ms, ctx.signal),
      },
      join: {
        access: "authenticated",
        handler: async ({ ctx }) => {
          ctx.rooms.join(WORLD);
          return { players: await ctx.presence.users(WORLD) };
        },
      },
    },
    channels: {
      move: (payload, ctx) => {
        ctx.rooms.emit(WORLD, game, "moved", { userId: ctx.principal.userId, ...payload });
        ticks += 1;
        qd.stream(game, "ticks").push({ n: ticks });
      },
    },
  });
}

/** The user a handshake's `auth` names: a known `token`, or the principal `app.connect` sends. */
function authenticate({
  auth,
}: {
  readonly auth: Readonly<Record<string, unknown>>;
}): string | null {
  const { principal, token } = auth;
  if (typeof principal === "object" && principal !== null && "userId" in principal) {
    return String(principal.userId);
  }
  if (token === undefined) {
    return null;
  }
  if (typeof token === "string" && TOKENS.includes(token)) {
    return token;
  }
  throw new QuickdrawError("UNAUTHENTICATED", "Unknown token");
}

/** Starts the game server on a free port: a heartbeat every 300 ms, one query at a time. */
export async function startServer() {
  return await createTestApp({
    services: [gameService()],
    auth: { authenticate },
    limits: { maxInFlightQueries: 1, maxQueuedQueries: 0, retryAfterMs: 300 },
    socket: { pingInterval: 300, pingTimeout: 1000 },
  });
}

export type GameServer = Awaited<ReturnType<typeof startServer>>;
