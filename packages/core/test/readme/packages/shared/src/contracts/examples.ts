// The README's contract examples beyond the quick start.

import {
  defineContract,
  listOf,
  nullable,
  query,
  type InputOf,
  type ItemOf,
  type OutputOf,
} from "@fitzzero/quickdraw-core";
import { z } from "zod";
import { taskContract } from "./task";

const labelSchema = z.object({ id: z.string(), projectId: z.string(), name: z.string() });

// #region outputs
export const labelContract = defineContract("labelService", {
  entity: labelSchema,
  projections: { chip: z.object({ id: z.string(), name: z.string() }) },
  methods: {
    find: query({ input: z.object({ name: z.string() }), output: nullable("entity") }),
    chips: query({ input: z.object({ projectId: z.string() }), output: listOf("chip") }),
    usage: query({ input: z.undefined(), output: z.record(z.string(), z.number()) }),
  },
});

// No entity: an RPC-only service, with no projections, field tiers or collections.
export const healthContract = defineContract("healthService", {
  methods: { ping: query({ input: z.undefined(), output: z.literal("pong") }) },
});
// #endregion

// #region types
// { id: string; title: string }
export type RenameInput = InputOf<typeof taskContract, "rename">;
// the entity, as the wire has it
export type Task = OutputOf<typeof taskContract, "get">;
// one item of the board
export type Card = ItemOf<typeof taskContract, "board">;
// #endregion
