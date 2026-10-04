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
export type { FrameMatch, FrameQuery, FrameRecorder, RecordedFrame, ServerFrameOf } from "./frames";
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
  ANONYMOUS,
  describeAccessMatrix,
  type AccessMatrixCase,
  type AccessMatrixCell,
  type AccessMatrixOptions,
  type AccessMatrixReport,
  type MatrixOutcome,
} from "./accessMatrix";
