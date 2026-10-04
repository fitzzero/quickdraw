import type { Outcome, Recorder } from "../recorder";
import type { BoardState } from "./board-state";

/**
 * What a scenario drives, whatever the wire protocol: each target (an app
 * under bench/apps/ and the client that speaks its protocol) implements
 * these with the client behavior of its version, so a scenario issues the
 * same work against every target.
 */

/** The quickdraw-core generations the harness can drive, by app name. */
export const TARGETS = ["v4", "v5"] as const;
export type Target = (typeof TARGETS)[number];

export interface DriverContext {
  url: string;
  recorder: Recorder;
}

export interface LoadResult {
  ok: boolean;
  /** From the start of the load until every piece of the board answered. */
  ms: number;
  /**
   * From the start of the load until the live pieces (the collection and
   * the entity subscriptions) answered, before the board query.
   */
  liveMs?: number;
  failure?: string;
}

/**
 * A board page: the `cardsByProject` collection, live subscriptions to the
 * 60 on-screen cards, and the `getTasksByStatus` board query, refetched
 * when the board changes.
 */
export interface BoardViewer {
  /** Connect and load the board; resolves when all three pieces have answered. */
  open(): Promise<LoadResult>;
  /** Drop the connection and reconnect straight away; resolves when the board is back. */
  drop(): Promise<LoadResult>;
  /** True while the viewer still has client-side work queued. */
  readonly busy: boolean;
  close(): void;
}

/** A writer in the fleet: edits the on-screen cards through `updateTask`. */
export interface BoardWriter {
  open(): Promise<void>;
  write(): Promise<Outcome>;
  close(): void;
}

/** An authenticated connection with no subscriptions. */
export interface PlainConnection {
  connect(): Promise<void>;
  /** One `getTasksByStatus` call. */
  readBoard(projectId: string): Promise<Outcome>;
  close(): void;
}

export interface Driver {
  readonly target: Target;
  viewer(
    ctx: DriverContext,
    token: string,
    projectId: string,
    entityIds: readonly string[],
  ): BoardViewer;
  writer(ctx: DriverContext, token: string, index: number, board: BoardState): BoardWriter;
  connection(ctx: DriverContext, token: string): PlainConnection;
  /** How this target's client and server were run, for the result file's notes. */
  readonly notes: readonly string[];
}
