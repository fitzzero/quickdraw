import type { ProjectMemberDTO } from "./types/project.js";

// Typed room events (4.0): emitToRoom/useRoomEvents payloads.
declare module "@fitzzero/quickdraw-core" {
  interface QuickdrawEventMap {
    "project:members": { members: ProjectMemberDTO[] };
    "project:archived": { id: string };
  }
}

export {};
