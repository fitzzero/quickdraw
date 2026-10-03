// Test helpers for quickdraw apps: @fitzzero/quickdraw-core/testing
// (RFC 0003 section 13). Prisma test databases are the separate
// ./testing/prisma export.

export {
  createTestApp,
  type TestApp,
  type TestAppOptions,
  type TestConnection,
} from "./createTestApp";
export { emitWithAck, waitForEvent } from "./socket";
export { createRecordingSink, type RecordedFlush, type RecordingSink } from "./recordingSink";
export {
  ANONYMOUS,
  describeAccessMatrix,
  type AccessMatrixCase,
  type AccessMatrixCell,
  type AccessMatrixOptions,
  type AccessMatrixReport,
  type MatrixOutcome,
} from "./accessMatrix";
