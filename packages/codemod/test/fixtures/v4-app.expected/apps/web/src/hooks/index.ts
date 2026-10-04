// Re-export typed hooks from quickdraw-core
// These wrap the generic hooks with project-specific types
// quickdraw-migrate: review [v4-api] 4.x API useRoomEvents (removed): lint's no-v4-api names each replacement
export { useRoomEvents } from "@fitzzero/quickdraw-core/client";
export { useMyProjects } from "./useMyProjects";
