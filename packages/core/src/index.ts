/** The published version of `@fitzzero/quickdraw-core`. Kept in step with package.json. */
export const QUICKDRAW_VERSION = "5.0.0-alpha.0";

// Contracts (RFC 0003 section 2). Plain data plus schemas: everything below is
// browser-safe, with no Node built-ins, React or server code.
export type { AccessLevel, ACE, ACL } from "./contract/access";
export { consoleLogger, type Logger } from "./contract/logger";
export {
  hasJsonSchema,
  isStandardSchema,
  validate,
  type InferInput,
  type InferOutput,
  type StandardJSONSchemaV1,
  type StandardSchemaV1,
  type StandardSchemaWithJSON,
  type StandardTypedV1,
  type ValidationIssue,
  type ValidationResult,
} from "./contract/standardSchema";
export {
  listOf,
  mutation,
  nullable,
  query,
  type EntityProjection,
  type MethodDef,
  type MethodKind,
  type MethodOutput,
  type MutationDef,
  type NullableProjection,
  type ProjectionList,
  type ProjectionRef,
  type QueryDef,
  type Watch,
} from "./contract/methods";
export {
  DEFAULT_COLLECTION_LIMIT,
  DEFAULT_COLLECTION_MAX_LIMIT,
  via,
  type CollectionDef,
  type CollectionWhere,
  type OrderBy,
  type SortDirection,
  type ViaScope,
  type Viewer,
  type ViewPredicate,
} from "./contract/collections";
export {
  defineContract,
  type AnyContract,
  type ChannelDef,
  type Contract,
  type ContractDefinition,
  type EventDef,
  type IndexRow,
  type ReservedMethodName,
  type RowSchema,
  type StreamDef,
} from "./contract/defineContract";
export type {
  ChannelPayloadOf,
  CollectionName,
  CollectionOf,
  ContractMap,
  EntityOf,
  EventPayloadOf,
  IndexFieldOf,
  IndexRowOf,
  InputOf,
  ItemOf,
  KindOf,
  MethodName,
  MethodOf,
  OutputOf,
  ParsedInputOf,
  ProjectionName,
  ProjectionOf,
  ScopeOf,
  ServiceNameOf,
  StreamItemOf,
  ViewName,
} from "./contract/infer";
export {
  CLIENT_EVENTS,
  SERVER_EVENTS,
  collectionRoom,
  entityRoom,
  topicRoom,
  userRoom,
  type ClientEventName,
  type ServerEventName,
} from "./contract/names";
