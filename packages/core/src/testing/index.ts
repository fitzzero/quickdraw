// Test helpers for quickdraw apps: @fitzzero/quickdraw-core/testing
// (RFC 0003 section 13). Prisma test databases are the separate
// ./testing/prisma export, and rendering components against a test app (or a
// mock client) is ./testing/client.

export {
  createTestApp,
  type TestApp,
  type TestAppOptions,
  type TestConnection,
} from "./createTestApp";
export {
  eventFrames,
  streamFrames,
  type EventQuery,
  type FrameMatch,
  type FrameQuery,
  type FrameRecorder,
  type RecordedFrame,
  type ServerFrameOf,
} from "./frames";
export { emitWithAck, waitForEvent } from "./socket";
export { createRecordingSink, type RecordedFlush, type RecordingSink } from "./recordingSink";
export {
  BUDGET_GROWTH_ENV,
  budgetFileOf,
  expectBudget,
  type Budget,
  type BudgetCall,
  type BudgetOptions,
  type BudgetResult,
} from "./budget";
export { BUDGET_BYTES_TOLERANCE } from "./budgetCompare";
export { DevWarningError, type DevWarning, type DevWarningKind } from "../server/devWarnings";
export {
  snapshotAccessMatrix,
  type AccessRows,
  type AccessSnapshotOptions,
  type AccessSnapshotRef,
  type AccessSnapshotReport,
} from "./accessSnapshot";
export type {
  AccessOutcome,
  AccessSnapshot,
  AccessSnapshotPrincipal,
  AccessSnapshotRow,
} from "./accessSnapshotCompare";
export {
  ACCESS_SNAPSHOT_ENV,
  accessSnapshotFileOf,
  type AccessSnapshotChange,
} from "./accessSnapshotFile";
export {
  ANONYMOUS,
  describeAccessMatrix,
  type AccessMatrixCase,
  type AccessMatrixCell,
  type AccessMatrixOptions,
  type AccessMatrixReport,
  type MatrixCell,
  type MatrixInputFactory,
  type MatrixOutcome,
} from "./accessMatrix";
