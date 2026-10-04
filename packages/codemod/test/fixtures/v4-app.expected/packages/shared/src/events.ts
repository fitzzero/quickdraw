import type { ProjectMemberDTO } from "./types/project.js";

// Typed room events (4.0): emitToRoom/useRoomEvents payloads.
// quickdraw-migrate: review [v4-api] QuickdrawEventMap typed 4.x room events: declare each event in its contract (events: { name: { payload } }), send it with ctx.rooms.emit and listen with qd.<service>.<event>.useEvent, then delete this augmentation
declare module "@fitzzero/quickdraw-core" {
  interface QuickdrawEventMap {
    "project:members": { members: ProjectMemberDTO[] };
    "project:archived": { id: string };
  }
}

export {};
