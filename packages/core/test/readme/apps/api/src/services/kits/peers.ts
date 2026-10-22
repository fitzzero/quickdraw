import { match } from "../../../../../packages/shared/src/kits/peers";
import { qd } from "../../quickdraw";

// #region service
// on a server created with peers: true, which forwards the links' signals and relays their messages
export const matchService = qd.defineService(match, {
  methods: {
    enterMatch: {
      access: "authenticated",
      handler: ({ input, ctx }) => {
        const room = `match:${input.matchId}`;
        const joined = ctx.rooms.join(room);
        if (joined && ctx.socketId !== undefined) {
          // the socket's own id, which a peer links to
          ctx.rooms.emit(room, match, "playerJoined", {
            matchId: input.matchId,
            userId: ctx.principal.userId,
            socketId: ctx.socketId,
          });
        }
        return joined;
      },
    },
  },
});
// #endregion
