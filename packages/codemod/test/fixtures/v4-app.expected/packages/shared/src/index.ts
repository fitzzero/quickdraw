// Shared types for the fullstack app: used by both server and client.

export type * from "./types/index.js";
// quickdraw-migrate: review [v4-api] 4.x API serviceRoom (removed): lint's no-v4-api names each replacement
export { serviceRoom, userRoom } from "@fitzzero/quickdraw-core";

// Side-effect import: loads the QuickdrawEventMap augmentation into every
// consumer's type graph.
import "./events.js";

export * from "./contracts/index.js";
