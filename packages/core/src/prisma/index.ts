// Tracked writes for Prisma: @fitzzero/quickdraw-core/prisma (RFC 0003
// sections 5.2 and 5.4). It imports nothing from Prisma: the client is
// passed in, and the server reads the database only through the structural
// storage adapter the tracked client carries.

export { trackPrisma, type PrismaClientLike, type TrackPrismaOptions } from "./trackPrisma";
export { findNestedWrites, type NestedWrite } from "./nested";
export {
  storageOf,
  type CountArgs,
  type FindManyArgs,
  type StorageAdapter,
  type StorageRow,
  type StorageWhere,
} from "../server/storage";
export type { StatementCount } from "../server/uow/unitOfWork";
