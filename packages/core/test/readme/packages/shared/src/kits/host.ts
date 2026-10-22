import { defineContract, mutation } from "@fitzzero/quickdraw-core";
import { z } from "zod";

/** The app room of arena `arenaId`: its host serves the arena's input and world. */
export const arenaRoom = (arenaId: string): string => `arena:${arenaId}`;

export const snapshotSchema = z.object({
  tick: z.number().int(),
  players: z.record(z.string(), z.object({ x: z.number(), y: z.number() })),
});

// #region contract
export const arena = defineContract("arenaService", {
  describe: "Arenas whose simulation one player's client runs, as the arena's host.",
  methods: {
    enterArena: mutation({
      input: z.object({ arenaId: z.string() }),
      output: z.boolean(),
      describe: "Joins the caller's socket to an arena's room.",
    }),
    hostArena: mutation({
      input: z.object({ arenaId: z.string() }),
      output: z.boolean(),
      describe: "Makes the caller's socket the arena's host, while it has none.",
    }),
  },
  channels: {
    // a player's input: to the arena's host over the player's link, never to the server
    steer: {
      payload: z.object({
        arenaId: z.string(),
        dx: z.number().min(-1).max(1),
        dy: z.number().min(-1).max(1),
      }),
      ratePerSecond: 30,
      requires: { room: (steer) => arenaRoom(steer.arenaId) },
      serve: "host",
    },
  },
  streams: {
    // the host's world, to each player of the arena: the latest snapshot seeds a newcomer
    world: {
      item: snapshotSchema,
      scope: "arenaId",
      seed: 1,
      volatile: true,
      access: { room: arenaRoom },
      serve: "host",
    },
  },
});
// #endregion
