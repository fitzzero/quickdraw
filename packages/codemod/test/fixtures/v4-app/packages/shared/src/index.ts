// Shared types for the fullstack app: used by both server and client.

export type * from "./types/index.js";
export { serviceRoom, userRoom } from "@fitzzero/quickdraw-core";

// Side-effect import: loads the QuickdrawEventMap augmentation into every
// consumer's type graph.
import "./events.js";
