import { arena, arenaRoom } from "../../../../../packages/shared/src/kits/host";
import { qd } from "../../quickdraw";

// #region service
// on a server created with peers: true, as host mode runs over peer links
export const arenaService = qd.defineService(arena, {
  methods: {
    enterArena: {
      access: "authenticated",
      handler: ({ input, ctx }) => ctx.rooms.join(arenaRoom(input.arenaId)),
    },
    hostArena: {
      // the app picks the host, never the server: here the first player who asks
      access: "authenticated",
      handler: ({ input, ctx }) => {
        const room = arenaRoom(input.arenaId);
        return ctx.rooms.hostOf(room) === null && ctx.rooms.setHost(room);
      },
    },
  },
  // no handler for steer and no options for world: the arena's host serves both
});
// #endregion
