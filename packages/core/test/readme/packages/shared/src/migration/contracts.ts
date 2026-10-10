// MIGRATION.md's 5.0 contracts: the shared types of the 4.x example app
// (packages/codemod/test/guide-v4), as contracts. Service names are kept.

import { defineContract, mutation, nullable, query } from "@fitzzero/quickdraw-core";
import { z } from "zod";

// #region contract
const cursorSchema = z.object({ projectId: z.string(), x: z.number() });

const taskEntity = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  status: z.string(),
  ordinal: z.number(),
  notes: z.string().nullable(),
});

export const taskContract = defineContract("taskService", {
  // new in 5.0: the codemod writes no describe; lint's require-describe lists each one missing
  describe: "Tasks on a project's board.",
  // was TaskDTO; a schema now, so it validates and lists its keys
  entity: taskEntity,
  // was getProtectedFields(): notes reach Moderate and up
  fields: { notes: "Moderate" },
  methods: {
    getTask: query({
      input: z.object({ id: z.string() }),
      output: nullable("entity"),
      describe: "Reads one task, or null.",
    }),
    renameTask: mutation({
      input: z.object({ id: z.string(), title: z.string().min(1) }),
      output: nullable("entity"),
      describe: "Renames a task, or answers null.",
    }),
    archiveAll: mutation({
      input: z.object({ projectId: z.string() }),
      output: z.object({ count: z.number() }),
      describe: "Archives every task of a project.",
    }),
  },
  collections: {
    // was defineCollection("byProject", ...): declared, so its deltas follow tracked writes
    byProject: {
      describe: "A project's tasks, by ordinal.",
      scope: "projectId",
      item: "entity",
      order: [
        ["ordinal", "asc"],
        ["id", "asc"],
      ],
    },
  },
  // was QuickdrawEventMap and emitToRoom
  events: {
    archived: {
      payload: z.object({ projectId: z.string() }),
      describe: "A project's tasks were archived.",
    },
    cursorMoved: { payload: cursorSchema, describe: "Another user's cursor moved." },
  },
  // was defineChannel
  channels: { cursor: { payload: cursorSchema, describe: "Where a user's cursor is." } },
});
// #endregion

// #region rpc
// No entity: an RPC-only contract, the 5.0 form of a BaseRpcService
export const healthContract = defineContract("healthService", {
  describe: "Tells a caller the server is up.",
  methods: {
    ping: query({
      input: z.undefined(),
      output: z.object({ at: z.string() }),
      describe: "Answers with the server's time.",
    }),
  },
});
// #endregion
