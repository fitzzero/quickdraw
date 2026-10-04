import { TARGET_NOTES } from "../notes";
import type { Driver } from "../types";
import { V5Viewer } from "./viewer";
import { V5PlainConnection } from "./plain";
import { V5Writer } from "./writer";

export { V5Viewer } from "./viewer";
export { V5PlainConnection } from "./plain";
export { V5Writer } from "./writer";

/** Protocol 5, spoken by the 5.0 client's own connection, live data and coordinator (`viewer.ts`). */
export const v5Driver: Driver = {
  target: "v5",
  viewer: (ctx, token, projectId, entityIds) => new V5Viewer(ctx, token, projectId, entityIds),
  writer: (ctx, token, index, board) => new V5Writer(ctx, token, index, board),
  connection: (ctx, token) => new V5PlainConnection(ctx, token),
  notes: TARGET_NOTES.v5,
};
