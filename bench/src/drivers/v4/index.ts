import { TARGET_NOTES } from "../notes";
import type { Driver } from "../types";
import { V4Connection } from "./connection";
import { Viewer } from "./viewer";
import { Writer } from "./writer";

export { V4Connection } from "./connection";
export { CLIENT_TIMEOUT_MS, EVENTS } from "./protocol";
export { Viewer } from "./viewer";
export { Writer } from "./writer";

/** The 4.1 wire protocol, spoken the way the 4.1 React hooks speak it (`viewer.ts`). */
export const v4Driver: Driver = {
  target: "v4",
  viewer: (ctx, token, projectId, entityIds) => new Viewer(ctx, token, projectId, entityIds),
  writer: (ctx, token, index, board) => new Writer(ctx, token, index, board),
  connection: (ctx, token) => new V4Connection(ctx, token),
  notes: TARGET_NOTES.v4,
};
