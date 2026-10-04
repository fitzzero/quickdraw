// Re-export typed hooks from quickdraw-core
// These wrap the generic hooks with project-specific types

export { useService } from "./useService";
export { useServiceQuery } from "./useServiceQuery";
export { useSubscription } from "./useSubscription";
export { useCollection, useRoomEvents } from "@fitzzero/quickdraw-core/client";
export { useMyProjects } from "./useMyProjects";
