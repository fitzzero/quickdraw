// Host mode's test game (`../hosts.test.ts`, the client's host tests and
// the cluster's): worlds whose rooms a method joins, a method that makes the
// caller its world's host, and a host-served channel and stream: `move`
// goes to the world's host over the sender's link, and the host pushes
// `world` to its peers. The server handles neither.

import { z } from "zod";
import { defineContract, mutation, query } from "../../../index";
import type { AppPrincipal } from "../../__tests__/fixtures";
import { initQuickdraw, type HostLeaveHandler } from "../../index";

/** The app room of world `worldId`. */
export const worldRoom = (worldId: string): string => `world:${worldId}`;

/** The world the tests play in, and its room. */
export const WORLD_ID = "1";
export const WORLD = worldRoom(WORLD_ID);

const worldInput = z.object({ worldId: z.string() });

export const moveSchema = z.object({
  worldId: z.string(),
  dx: z.number().int().min(-1).max(1),
  dy: z.number().int().min(-1).max(1),
});

export const snapshotSchema = z.object({ tick: z.number().int(), players: z.array(z.string()) });

export const gameContract = defineContract("gameService", {
  methods: {
    enter: mutation({ input: worldInput, output: z.boolean() }),
    exit: mutation({ input: worldInput, output: z.boolean() }),
    /** Makes the calling socket its world's host. */
    host: mutation({ input: worldInput, output: z.boolean() }),
    unhost: mutation({ input: worldInput, output: z.null() }),
    kick: mutation({ input: worldInput.extend({ userId: z.string() }), output: z.null() }),
    hostOf: query({ input: worldInput, output: z.string().nullable() }),
  },
  channels: {
    move: {
      payload: moveSchema,
      ratePerSecond: 10,
      burst: 5,
      requires: { room: (move) => worldRoom(move.worldId) },
      serve: "host",
    },
  },
  streams: {
    world: {
      item: snapshotSchema,
      scope: "worldId",
      seed: 2,
      volatile: true,
      access: { room: (worldId) => worldRoom(worldId) },
      serve: "host",
    },
  },
});

/** The instance the game's service is defined with: `qd.stream` reaches the test app created last. */
export const qd = initQuickdraw<{ principal: AppPrincipal }>();

/** The game's service; `onHostLeave` hears its worlds' hosts leave. */
export function defineGameService(onHostLeave?: HostLeaveHandler) {
  return qd.defineService(gameContract, {
    methods: {
      enter: {
        access: "public",
        handler: ({ input, ctx }) => ctx.rooms.join(worldRoom(input.worldId)),
      },
      exit: {
        access: "public",
        handler: ({ input, ctx }) => ctx.rooms.leave(worldRoom(input.worldId)),
      },
      host: {
        access: "public",
        handler: ({ input, ctx }) => ctx.rooms.setHost(worldRoom(input.worldId)),
      },
      unhost: {
        access: "authenticated",
        handler: ({ input, ctx }) => {
          ctx.rooms.clearHost(worldRoom(input.worldId));
          return null;
        },
      },
      kick: {
        access: "authenticated",
        handler: async ({ input, ctx }) => {
          await ctx.rooms.leave(worldRoom(input.worldId), { userId: input.userId });
          return null;
        },
      },
      hostOf: {
        access: "public",
        handler: ({ input, ctx }) => ctx.rooms.hostOf(worldRoom(input.worldId)),
      },
    },
    ...(onHostLeave === undefined ? {} : { onHostLeave }),
  });
}
