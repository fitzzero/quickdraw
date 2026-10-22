import { defineContract, mutation } from "@fitzzero/quickdraw-core";
import { z } from "zod";

// what players send each other over their links: the server never sees it
export const moveSchema = z.object({ x: z.number(), y: z.number() });

export type Move = z.infer<typeof moveSchema>;

export const match = defineContract("matchService", {
  describe: "Small matches whose players link to each other.",
  methods: {
    enterMatch: mutation({
      input: z.object({ matchId: z.string() }),
      output: z.boolean(),
      describe: "Joins the caller's socket to a match's room, and tells the players there.",
    }),
  },
  events: {
    // a socket id lives as long as its connection: a client joins again, and is announced
    // again, on every connection
    playerJoined: {
      payload: z.object({ matchId: z.string(), userId: z.string(), socketId: z.string() }),
      describe: "A player's socket joined the match: the players there link to it.",
    },
  },
});
