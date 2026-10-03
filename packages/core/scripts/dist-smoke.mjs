// Smoke test for the built package. Run it after `bun run build`:
//
//   node packages/core/scripts/dist-smoke.mjs
//
// It imports every export in package.json through the package's own name, so
// Node resolves each one through the export map exactly as a consumer would,
// and then checks the output shape:
//
// - each export provides its known symbols, and the root export's declarations
//   provide every public type;
// - the root export is browser-safe: its whole import graph is the package's
//   own files, with no Node built-in and no dependency; so is `./utils`, the
//   isomorphic entry React server components import;
// - `./client` opens with the "use client" directive and no other export does
//   (`./utils` in particular), and re-exports `./utils`;
// - every source module is emitted into exactly one output file (entries share
//   chunks; with `splitting` off each entry would carry its own copy);
// - no dependency is bundled (every source path is the package's own);
// - the Redis helper's dynamic imports of its optional peers resolve from the
//   built output (both are devDependencies, so they are installed here);
// - the built JSON parser (`./parser`) writes what the stock socket.io-parser
//   encoder writes, reports the size, and refuses a binary argument;
// - the built method runtime (`./server`) defines a service from a contract,
//   runs a call through the dispatcher and its in-process caller, and answers
//   invalid input with VALIDATION;
// - the built read/write kit's halves find each other: `crud.contract` from
//   the root marks the methods it made, and `crud.handlers` from `./server`
//   implements them, so both entries share one copy of the kit's registry;
//   the search kit's halves (`search.contract`, `search.handlers`) likewise,
//   and the sharing kit's (`sharing.contract`, `sharing.handlers`), which
//   also read the policies' columns through accessors `./server` shares, and
//   the admin kit's (`admin.contract`, `admin.handlers`), whose metadata
//   comes from the entity's JSON Schema;
// - the built server factory, booted by the built test app (`./testing`),
//   serves a call over a v5 socket, over HTTP and through the 4.x shim;
// - the built client (`./client`) calls through its connection over a v5
//   socket, and the built server caller (`./utils`) over HTTP;
// - the built server, through the built test app, answers a stream subscribe
//   with its seed and then pushes, delivers a channel message to its
//   handler, joins an app room through a method (with its `qd:presence`
//   list) and sends that room a typed event; its presence sees the socket;
// - the built MCP bridge (`./server/mcp`) lists a contract's method as a
//   tool and serves a call through its stdio server, and `./server` carries
//   none of the bridge's code;
// - the built tracked-writes adapter (`./prisma`) imports nothing from Prisma,
//   refuses a value that is not a Prisma client, and shares one storage
//   lookup with `./server`;
// - the built client test helpers (`./testing/client`) carry no "use client"
//   (while `dist/client/index.js` still opens with it), load Testing Library
//   only lazily, import no jsdom and no server code, and the built mock
//   client answers from its stubs with no DOM;
// - the built auth routes kit (`./server/auth`) imports neither express nor
//   express-rate-limit statically, signs in through the mock provider (start,
//   consent, callback), answers `me`, authenticates a socket by the session
//   cookie through the built `socketAuth`, and after logout refuses both.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(packageDir, "dist");
const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));

/** The symbols each export must provide, and whether the export is client code. */
const expectations = {
  ".": {
    symbols: [
      "QUICKDRAW_VERSION",
      "consoleLogger",
      "validate",
      "isStandardSchema",
      "hasJsonSchema",
      "query",
      "mutation",
      "nullable",
      "listOf",
      "via",
      "DEFAULT_COLLECTION_LIMIT",
      "DEFAULT_COLLECTION_MAX_LIMIT",
      "defineContract",
      "entityRoom",
      "collectionRoom",
      "topicRoom",
      "userRoom",
      "CLIENT_EVENTS",
      "SERVER_EVENTS",
      "ERROR_CODES",
      "QuickdrawError",
      "httpStatus",
      "isErrorCode",
      "toWire",
      "fromWire",
      "PROTOCOL_VERSION",
      "PROTOCOL_MISMATCH",
      "isQdHandshake",
      "isProtocolMismatch",
      "isAuthenticationRefused",
      "isCallEnvelope",
      "isCancel",
      "crud",
      "CRUD_METHODS",
      "CRUD_MAX_IDS",
      "LIST_DEFAULT_LIMIT",
      "LIST_MAX_LIMIT",
      "search",
      "SEARCH_DEFAULT_LIMIT",
      "SEARCH_DEFAULT_MIN_LENGTH",
      "SEARCH_MAX_LIMIT",
      "SEARCH_MAX_QUERY_LENGTH",
      "sharing",
      "SHARING_METHODS",
      "SHARE_LEVELS",
      "admin",
      "ADMIN_METHODS",
      "ADMIN_FIELD_TYPES",
      "ADMIN_NEVER_WRITABLE",
      "ADMIN_DEFAULT_PAGE_SIZE",
      "ADMIN_MAX_PAGE_SIZE",
      "ADMIN_MAX_PAGE",
      "streamRoom",
      "RESERVED_ROOM_PREFIXES",
      "GLOBAL_STREAM",
      "STREAM_MAX_SEED",
      "CHANNEL_DEFAULT_RATE",
      "isScopedStream",
    ],
    client: false,
  },
  "./server": {
    symbols: [
      "initQuickdraw",
      "createDispatcher",
      "custom",
      "owner",
      "jsonAcl",
      "members",
      "inherit",
      "anyOf",
      "resolver",
      "createBasicAccessEngine",
      "meetsLevel",
      "serviceGrant",
      "toCallReply",
      "DEFAULT_LIMITS",
      "createServer",
      "createHttpRouter",
      "createRateLimiter",
      "storageOf",
      "ANY_FIELD",
      "crud",
      "nextOrdinal",
      "ORDINAL_STEP",
      "requireRow",
      "search",
      "sharing",
      "admin",
      "ADMIN_HIDDEN_FIELDS",
      "displayNameOf",
      "labelOf",
      "MAX_APP_ROOMS",
      "PRESENCE_MAX_LAST_SEEN",
      "STREAM_MAX_SCOPES",
      "MAX_STREAMS_PER_SOCKET",
      "CHANNEL_ABUSE_WINDOW_MS",
      "CHANNEL_ABUSE_MULTIPLIER",
    ],
    client: false,
  },
  "./server/auth": {
    symbols: [
      "createJWT",
      "createAuthRoutes",
      "socketAuth",
      "createMemorySessionStore",
      "google",
      "discord",
      "mock",
      "guest",
      "issueSession",
      "liveSession",
    ],
    client: false,
  },
  "./server/express": { symbols: ["createJsonRateLimiter", "createCallLimiter"], client: false },
  "./server/mcp": {
    symbols: [
      "describeTools",
      "createMcpRegistry",
      "toToolResult",
      "createMcpStdioServer",
      "MCP_PROTOCOL_VERSION",
      "bootstrapMcpServer",
      "createMcpHttpRouter",
    ],
    client: false,
  },
  "./client": {
    symbols: [
      "createQuickdrawClient",
      "QuickdrawProvider",
      "useQuickdraw",
      "createQuickdrawConnection",
      "call",
      "callData",
      "isNotModified",
      "shouldRetry",
      "reloadOncePerSession",
      "DEFAULT_BACKOFF_MS",
      "createInvalidationCoordinator",
      "DEFAULT_INVALIDATION_WINDOW_MS",
      "RECONNECT_JITTER_MS",
      "overlaysOf",
      "sessionOf",
      "DEFAULT_SUBSCRIPTION_LANE",
      "liveDataOf",
      "emptyCollection",
      "applyCollectionSnapshot",
      "applyCollectionPage",
      "applyCollectionDeltas",
      "applyCollectionFrames",
      "applyCollectionItems",
      "applyCollectionKept",
      "SEARCH_DEBOUNCE_MS",
      "useAdminServices",
      "getAuthToken",
      "createServerCaller",
      "methodKey",
      "entityKey",
      "collectionKey",
      "formatCurrency",
      "parseJWTPayload",
      "usePresence",
      "STREAM_DEFAULT_MAX",
      "STREAM_MAX_ITEMS",
      "PENDING_STREAM",
      "feedKey",
    ],
    client: true,
  },
  "./utils": {
    symbols: [
      "formatCurrency",
      "buildBreadcrumbs",
      "parseJWTPayload",
      "createServerCaller",
      "methodKey",
      "methodKeyPrefix",
      "serviceKeyPrefix",
      "entityKey",
      "collectionKey",
      "KEY_ROOT",
    ],
    client: false,
  },
  "./parser": { symbols: ["createJsonParser"], client: false },
  "./prisma": { symbols: ["trackPrisma", "storageOf", "findNestedWrites"], client: false },
  "./testing": {
    symbols: [
      "createTestApp",
      "emitWithAck",
      "waitForEvent",
      "createRecordingSink",
      "describeAccessMatrix",
    ],
    client: false,
  },
  "./testing/prisma": { symbols: ["createPrismaTestGlobalSetup"], client: false },
  "./testing/client": { symbols: ["renderWithQuickdraw", "createMockClient"], client: false },
};

/** The type-only names the root export's declarations must provide. */
const rootTypes = [
  "AccessLevel",
  "ACE",
  "ACL",
  "Logger",
  "StandardTypedV1",
  "StandardSchemaV1",
  "StandardJSONSchemaV1",
  "StandardSchemaWithJSON",
  "InferInput",
  "InferOutput",
  "ValidationIssue",
  "ValidationResult",
  "MethodKind",
  "EntityProjection",
  "NullableProjection",
  "ProjectionList",
  "ProjectionRef",
  "MethodOutput",
  "Watch",
  "QueryDef",
  "MutationDef",
  "MethodDef",
  "ViaScope",
  "SortDirection",
  "OrderBy",
  "Viewer",
  "ViewPredicate",
  "CollectionWhere",
  "CollectionDef",
  "RowSchema",
  "StreamDef",
  "ChannelDef",
  "EventDef",
  "StreamAccess",
  "ChannelRequires",
  "PayloadSelector",
  "ContractDefinition",
  "Contract",
  "AnyContract",
  "IndexRow",
  "ReservedMethodName",
  "ContractMap",
  "ServiceNameOf",
  "EntityOf",
  "ProjectionName",
  "ProjectionOf",
  "MethodName",
  "MethodOf",
  "KindOf",
  "InputOf",
  "ParsedInputOf",
  "OutputOf",
  "CollectionName",
  "CollectionOf",
  "ItemOf",
  "ScopeOf",
  "IndexFieldOf",
  "IndexRowOf",
  "ViewName",
  "StreamItemOf",
  "ChannelPayloadOf",
  "EventPayloadOf",
  "StreamName",
  "ChannelName",
  "EventName",
  "IsScopedStream",
  "ChannelInputOf",
  "ClientEventName",
  "ServerEventName",
  // contract/kits: the read/write kit's contract half
  "CrudMethodName",
  "CrudTag",
  "CrudToggle",
  "CrudListOptions",
  "CrudInputOptions",
  "CrudReorderOptions",
  "CrudContractOptions",
  "CrudMethods",
  "CrudGet",
  "CrudGetMany",
  "CrudList",
  "CrudCreate",
  "CrudUpdate",
  "CrudDelete",
  "CrudReorder",
  "CrudBulkUpdate",
  "CrudBulkDelete",
  "ListInput",
  "ScalarFieldOf",
  "NumberFieldOf",
  "IdInput",
  "IdsInput",
  "BulkResult",
  "ReorderInput",
  "WithId",
  "BulkPatch",
  "FilterValue",
  "ListSort",
  "ListQuery",
  "ListPage",
  // contract/kits: the search kit's contract half
  "SearchContractOptions",
  "SearchDef",
  "SearchMethods",
  "SearchTag",
  "TextFieldOf",
  "SearchInput",
  "SearchPage",
  "SearchQuery",
  // contract/kits: the sharing kit's contract half
  "SharingMode",
  "AclMethodName",
  "MembersMethodName",
  "SharingMethodName",
  "SharingByNameMethod",
  "SharingTag",
  "SharingContractOptions",
  "SharingMethods",
  "SharingDefOf",
  "SharingShare",
  "SharingShareByName",
  "SharingUnshare",
  "SharingSetLevel",
  "SharingListShares",
  "SharingInvite",
  "SharingInviteByName",
  "SharingRemove",
  "SharingLeave",
  "SharingSetRole",
  "SharingListMembers",
  "ShareLevel",
  "ShareInput",
  "UnshareInput",
  "UserLookupInput",
  "ShareByNameInput",
  "ShareByNameQuery",
  "InviteInput",
  "InviteQuery",
  "InviteByNameInput",
  "InviteByNameQuery",
  "MemberInput",
  "LeaveInput",
  "SetRoleInput",
  "ListMembersInput",
  "ListMembersQuery",
  "Member",
  "MembersPage",
  // contract/kits: the admin kit's contract half
  "AdminMethodName",
  "AdminTag",
  "AdminMethodsOf",
  "AdminContractOptions",
  "AdminMethods",
  "AdminListDef",
  "AdminGetDef",
  "AdminCreateDef",
  "AdminUpdateDef",
  "AdminDeleteDef",
  "AdminMetaDef",
  "AdminSubscribersDef",
  "AdminReemitDef",
  "AdminFieldType",
  "AdminFieldConfig",
  "AdminServiceMeta",
  "AdminListInput",
  "AdminListQuery",
  "AdminPage",
  "AdminNeverWritable",
  "AdminData",
  "AdminCreateInput",
  "AdminUpdateInput",
  "AdminCreateQuery",
  "AdminUpdateQuery",
  "AdminMetaInput",
  "SubscriberLevel",
  "AdminSubscribers",
  "KitSchema",
  // protocol/errors.ts
  "ErrorCode",
  "WireError",
  "WireIssue",
  "ValidationErrorData",
  "RateLimitedErrorData",
  // protocol/version.ts
  "QdHandshake",
  "HandshakeAuth",
  "ProtocolMismatch",
  "AuthenticationRefused",
  "HelloLimits",
  "HelloFrame",
  // protocol/envelope.ts
  "Revision",
  "Version",
  "CallId",
  "Ok",
  "Failure",
  "CallEnvelope",
  "CallSuccess",
  "CallNotModified",
  "CallReply",
  "CancelFrame",
  "EntitySubscribe",
  "EntityRow",
  "EntityNotModified",
  "EntityResult",
  "EntitySubscribeReply",
  "EntityUnsubscribe",
  "EntityUpdate",
  "EntityPatch",
  "EntityRemove",
  "EntityFrame",
  "CollectionScopeRef",
  "CollectionSubscribe",
  "WireIndexRow",
  "CollectionSnapshot",
  "CollectionResumed",
  "CollectionSubscribeReply",
  "CollectionItemsRequest",
  "CollectionItemsReply",
  "CollectionDelta",
  "CollectionFrame",
  "WatchFrame",
  "ChangedFrame",
  "StreamSubscribe",
  "StreamSubscribeReply",
  "StreamFrame",
  "ChannelFrame",
  "EventFrame",
  "PresenceFrame",
  "RevokeReason",
  "RevokedFrame",
  "RotateFrame",
  "AccessFrame",
  "ClientToServerEvents",
  "ServerToClientEvents",
];

const USE_CLIENT = /^(["'])use client\1;?/;

const exportPaths = Object.keys(pkg.exports).filter((path) => path !== "./package.json");
assert.deepEqual(
  [...exportPaths].sort(),
  Object.keys(expectations).sort(),
  "every export in package.json needs an entry in this script's expectations",
);

for (const exportPath of exportPaths) {
  const target = pkg.exports[exportPath];
  const { symbols, client } = expectations[exportPath];

  for (const file of [target.types, target.import]) {
    assert.ok(existsSync(join(packageDir, file)), `${exportPath}: ${file} is missing`);
  }

  const specifier = exportPath === "." ? pkg.name : `${pkg.name}${exportPath.slice(1)}`;
  const module = await import(specifier);
  for (const symbol of symbols) {
    assert.notEqual(module[symbol], undefined, `${specifier} does not export ${symbol}`);
  }

  const code = readFileSync(join(packageDir, target.import), "utf8");
  assert.equal(
    USE_CLIENT.test(code),
    client,
    `${target.import} ${client ? "must" : "must not"} begin with "use client"`,
  );

  const exported = symbols.length === 1 ? symbols[0] : `${symbols.length} symbols`;
  console.log(
    `ok ${specifier} exports ${exported}${client ? ' and begins with "use client"' : ""}`,
  );
}

// The names in the root declarations' `export { ... }` lists, without `type`
// and taking the exported name of `local as exported`.
const rootDeclarations = readFileSync(join(packageDir, pkg.exports["."].types), "utf8");
const declaredNames = new Set(
  [...rootDeclarations.matchAll(/^export \{([^}]*)\}/gm)].flatMap(([, list]) =>
    list
      .split(",")
      .map((entry) =>
        entry
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)
          .at(-1),
      )
      .filter(Boolean),
  ),
);
const missingTypes = rootTypes.filter((name) => !declaredNames.has(name));
assert.deepEqual(missingTypes, [], `${pkg.exports["."].types} does not export these types`);
console.log(`ok ${pkg.name} declares ${rootTypes.length} public types`);

// Browser code imports the root export, so its import graph may hold only the
// package's own files: no Node built-in, no dependency, no server module.
const IMPORT_SPECIFIER = /\bfrom\s*["']([^"']+)["']|\bimport\s*\(?\s*["']([^"']+)["']/g;

/** The files an export's import graph holds, and what it imports from outside the package. */
function importGraph(exportPath) {
  const files = new Set();
  const pending = [join(packageDir, pkg.exports[exportPath].import)];
  const externals = [];
  while (pending.length > 0) {
    const file = pending.pop();
    if (files.has(file)) {
      continue;
    }
    files.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT_SPECIFIER)) {
      const imported = match[1] ?? match[2];
      if (imported.startsWith("./") || imported.startsWith("../")) {
        pending.push(resolve(dirname(file), imported));
      } else {
        externals.push(`${relative(packageDir, file)} imports ${imported}`);
      }
    }
  }
  return { files, externals };
}

const rootGraph = importGraph(".");
assert.deepEqual(
  rootGraph.externals,
  [],
  "the root export must not import packages or Node built-ins",
);
console.log(
  `ok ${pkg.name} imports only its own ${rootGraph.files.size} files, so it runs in a browser`,
);

// React server components import ./utils, so it may not pull in React,
// Socket.IO or Node built-ins either; ./client re-exports all of it.
const utilsGraph = importGraph("./utils");
assert.deepEqual(utilsGraph.externals, [], "./utils must not import packages or Node built-ins");
const utilsEntry = await import(`${pkg.name}/utils`);
const clientEntry = await import(`${pkg.name}/client`);
for (const [name, value] of Object.entries(utilsEntry)) {
  assert.equal(clientEntry[name], value, `./client must re-export ${name} from ./utils`);
}
console.log(
  `ok ${pkg.name}/utils imports only its own ${utilsGraph.files.size} files, and ./client re-exports it`,
);

const sourceMaps = readdirSync(distDir, { recursive: true })
  .map(String)
  .filter((file) => file.endsWith(".js.map"));
assert.ok(sourceMaps.length > 0, "dist has no source maps; the build must emit them");

const emittedIn = new Map();
for (const mapFile of sourceMaps) {
  const { sources } = JSON.parse(readFileSync(join(distDir, mapFile), "utf8"));
  for (const source of sources) {
    const sourcePath = relative(packageDir, resolve(distDir, dirname(mapFile), source));
    emittedIn.set(sourcePath, [...(emittedIn.get(sourcePath) ?? []), mapFile.slice(0, -4)]);
  }
}

const bundled = [...emittedIn.keys()].filter((source) => !source.startsWith("src/"));
assert.deepEqual(bundled, [], "dependencies were bundled into dist instead of staying external");

const duplicated = [...emittedIn].filter(([, outputs]) => outputs.length > 1);
assert.deepEqual(duplicated, [], "source modules were emitted more than once; is splitting off?");
console.log(`ok ${emittedIn.size} source modules, each emitted once, no bundled dependencies`);

const { isRedisAdapterAvailable } = await import(`${pkg.name}/server`);
assert.equal(await isRedisAdapterAvailable(), true, "the Redis helper could not import its peers");
console.log("ok the Redis helper imports redis and @socket.io/redis-adapter");

// The JSON parser is built on a method that socket.io-parser's declarations
// mark private, so check the built output against the installed stock encoder.
const { createJsonParser } = await import(`${pkg.name}/parser`);
const stockParser = await import("socket.io-parser");
const reported = [];
const jsonParser = createJsonParser({ onEncoded: (_packet, bytes) => reported.push(bytes) });
const sample = {
  type: stockParser.PacketType.ACK,
  nsp: "/admin",
  id: 7,
  data: [{ ok: true, d: { text: "héllo 🎉", list: [1, null, { deep: true }] }, v: 3 }],
};
const written = new jsonParser.Encoder().encode(sample);
assert.deepEqual(written, new stockParser.Encoder().encode(sample), "the JSON encoder must match");
assert.deepEqual(reported, [Buffer.byteLength(written[0], "utf8")], "onEncoded reports bytes");
assert.throws(
  () => new jsonParser.Encoder().encode({ type: 2, nsp: "/", data: ["x", new Uint8Array(1)] }),
  TypeError,
);
assert.equal(jsonParser.Decoder, stockParser.Decoder, "the JSON parser decodes with the stock one");
console.log("ok the built JSON parser writes what the stock encoder writes and refuses binary");

// The method runtime across the built entries: a contract from the root, a
// service and a dispatcher from ./server, called in process and on the wire.
const core = await import(pkg.name);
const server = await import(`${pkg.name}/server`);
const text = {
  "~standard": {
    version: 1,
    vendor: "smoke",
    validate: (value) =>
      typeof value === "string" ? { value } : { issues: [{ message: "Expected a string" }] },
  },
};
const echo = core.defineContract("echoService", {
  methods: { say: core.query({ input: text, output: text }) },
});
const app = server.initQuickdraw();
const echoService = app.defineService(echo, {
  methods: { say: { access: "public", handler: ({ input }) => input.toUpperCase() } },
});
const records = [];
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };
const dispatcher = server.createDispatcher({
  services: [echoService],
  logger: quiet,
  onCall: (record) => records.push(record),
});
assert.equal(await dispatcher.caller(null).echoService.say("hi"), "HI");
const invalid = await dispatcher.call({
  service: "echoService",
  method: "say",
  input: 3,
  principal: null,
  transport: "socket",
});
assert.deepEqual(server.toCallReply(invalid), {
  ok: false,
  e: {
    code: "VALIDATION",
    message: "Invalid input for echoService.say",
    data: { issues: [{ path: [], message: "Expected a string" }] },
  },
});
assert.deepEqual(
  records.map((record) => [record.transport, record.outcome]),
  [
    ["internal", "ok"],
    ["socket", "VALIDATION"],
  ],
);
console.log("ok the built dispatcher runs a call in process and validates input on the wire");

// The read/write kit across the built entries: the methods `crud.contract`
// (root) made are found by `crud.handlers` (./server), and served through a
// database client with the model's delegate.
const anything = {
  "~standard": { version: 1, vendor: "smoke", validate: (value) => ({ value }) },
};
const notes = core.defineContract("noteService", {
  entity: anything,
  methods: { ...core.crud.contract({ entity: anything, get: true, list: {} }) },
});
const note = { id: "n1", title: "Note", body: "not projected" };
const kitDb = {
  note: { findUnique: async () => note, findMany: async () => [note], count: async () => 1 },
};
const noteService = app.defineService(notes, {
  model: "note",
  project: { entity: { keys: ["id", "title"] } },
  methods: { ...server.crud.handlers(notes, { access: { get: "public", list: "public" } }) },
});
const kitCaller = server
  .createDispatcher({ services: [noteService], db: kitDb, logger: quiet })
  .caller(null).noteService;
assert.deepEqual(await kitCaller.get({ id: "n1" }), { id: "n1", title: "Note" });
assert.deepEqual(await kitCaller.list(), {
  items: [{ id: "n1", title: "Note" }],
  nextCursor: null,
});
console.log("ok the built read/write kit's contract and server halves find each other");

// The search kit across the built entries: the method `search.contract`
// (root) made is found by `search.handlers` (./server), and reads its page
// through the database client.
const searchable = core.defineContract("findService", {
  entity: anything,
  methods: { ...core.search.contract({ entity: anything, fields: ["title"] }) },
});
const findService = app.defineService(searchable, {
  model: "note",
  project: { entity: { keys: ["id", "title"] } },
  methods: { ...server.search.handlers(searchable, { access: "public" }) },
});
const findCaller = server
  .createDispatcher({ services: [findService], db: kitDb, logger: quiet })
  .caller(null).findService;
assert.deepEqual(await findCaller.search({ q: "  note " }), {
  items: [{ id: "n1", title: "Note" }],
  nextCursor: null,
});
assert.deepEqual(await findCaller.search({ q: "n" }), { items: [], nextCursor: null });
console.log("ok the built search kit's contract and server halves find each other");

// The sharing kit across the built entries: the methods `sharing.contract`
// (root) made are found by `sharing.handlers` (./server), which reads the
// access list and membership table names from the service's policy through
// the policy builders' own accessors, so a service whose policy has none is
// refused when it is defined.
const shared = core.defineContract("sharedService", {
  entity: anything,
  methods: {
    ...core.sharing.contract({ mode: "acl", methods: ["share", "listShares"] }),
    ...core.sharing.contract({ mode: "members", methods: ["leave"] }),
  },
});
const sharingHandlers = server.sharing.handlers(shared);
assert.deepEqual(Object.keys(sharingHandlers), ["share", "listShares", "leave"]);
assert.deepEqual(
  Object.values(sharingHandlers).map((entry) => entry.access),
  [{ entry: "Admin" }, { entry: "Read" }, "authenticated"],
);
const sharedPolicy = server.anyOf(
  server.jsonAcl("acl", { owner: "ownerId" }),
  server.members({ model: "member", entry: "noteId", user: "userId", level: "role" }),
);
const sharedProject = { entity: { keys: ["id", "title"] } };
assert.equal(
  app.defineService(shared, {
    model: "note",
    access: sharedPolicy,
    project: sharedProject,
    methods: sharingHandlers,
  }).name,
  "sharedService",
);
assert.throws(
  () =>
    app.defineService(shared, {
      model: "note",
      access: server.owner("ownerId"),
      project: sharedProject,
      methods: server.sharing.handlers(shared),
    }),
  /need a jsonAcl\(field\) policy/,
);
assert.throws(
  () => server.sharing.handlers(echo),
  /echoService has no method sharing.contract made/,
);
console.log("ok the built sharing kit's contract and server halves find each other");

// The admin kit across the built entries: the methods `admin.contract` (root)
// made are found by `admin.handlers` (./server), each under a service-wide
// Admin grant, and `adminMeta` answers from the entity's JSON Schema, which
// the contract half requires.
const described = {
  "~standard": {
    version: 1,
    vendor: "smoke",
    validate: (value) => ({ value }),
    jsonSchema: {
      input: () => ({
        type: "object",
        properties: { id: { type: "string" }, title: { type: "string" } },
        required: ["id", "title"],
      }),
      output: () => ({
        type: "object",
        properties: { id: { type: "string" }, title: { type: "string" } },
        required: ["id", "title"],
      }),
    },
  },
};
const administered = core.defineContract("adminService", {
  entity: described,
  methods: { ...core.admin.contract({ entity: described, expose: ["adminGet", "adminMeta"] }) },
});
const adminHandlers = server.admin.handlers(administered);
assert.deepEqual(
  Object.values(adminHandlers).map((entry) => entry.access),
  [{ service: "Admin" }, { service: "Admin" }],
);
const adminService = app.defineService(administered, { model: "note", methods: adminHandlers });
const adminDispatcher = server.createDispatcher({
  services: [adminService],
  db: kitDb,
  logger: quiet,
});
const administrator = adminDispatcher.caller({
  userId: "smoke",
  serviceAccess: { adminService: "Admin" },
}).adminService;
assert.deepEqual(await administrator.adminGet({ id: "n1" }), { id: "n1", title: "Note" });
assert.deepEqual(
  (await administrator.adminMeta()).fields.map((field) => [field.name, field.type, field.editable]),
  [
    ["id", "string", false],
    ["title", "string", true],
  ],
);
await assert.rejects(
  adminDispatcher.caller({ userId: "smoke" }).adminService.adminGet({ id: "n1" }),
  { code: "FORBIDDEN" },
);
assert.throws(() => core.admin.contract({ entity: anything }), /cannot describe itself/);
console.log("ok the built admin kit's contract and server halves find each other");

// The built server factory and its transports, booted by the built test app:
// a v5 call over a real socket, an HTTP call, and a 4.x call through the shim.
const testing = await import(`${pkg.name}/testing`);
const { io: connectClient } = await import("socket.io-client");
const testApp = await testing.createTestApp({
  services: [echoService],
  logger: quiet,
  legacyWire: true,
});
try {
  const connection = await testApp.connect({ userId: "smoke" });
  assert.equal(connection.hello.protocol, core.PROTOCOL_VERSION);
  assert.equal(await connection.call.echoService.say("socket"), "SOCKET");
  const response = await fetch(`${testApp.url}/qd/echoService/say`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify("http"),
  });
  assert.deepEqual(await response.json(), { ok: true, d: "HTTP" });
  const legacy = connectClient(testApp.url, {
    forceNew: true,
    reconnection: false,
    transports: ["websocket"],
  });
  try {
    assert.deepEqual(await legacy.timeout(5000).emitWithAck("echoService:say", "legacy"), {
      success: true,
      data: "LEGACY",
    });
  } finally {
    legacy.disconnect();
  }

  // The built client: its React-free connection and call over a v5 socket,
  // and the server caller from ./utils over HTTP.
  const clientConnection = clientEntry.createQuickdrawConnection({
    url: testApp.url,
    auth: { principal: { userId: "smoke" } },
    transports: ["websocket"],
  });
  clientConnection.open();
  try {
    assert.deepEqual(
      await clientEntry.call(clientConnection, {
        service: "echoService",
        method: "say",
        input: "client",
      }),
      { ok: true, d: "CLIENT" },
    );
  } finally {
    clientConnection.close();
  }
  const httpCaller = utilsEntry.createServerCaller({ echo }, { url: testApp.url });
  assert.equal(await httpCaller.echo.say.call("caller"), "CALLER");
  assert.deepEqual(httpCaller.echo.say.key("caller"), ["qd", "echoService", "m", "say", "caller"]);
} finally {
  await testApp.close();
}
console.log(
  "ok the built server serves a call over a v5 socket, over HTTP and through the 4.x shim",
);
console.log(
  "ok the built client calls over its v5 connection, and the built server caller over HTTP",
);

// Presence, streams, channels and typed events across the built entries: a
// contract from the root, served by ./server through the built test app, and
// a v5 socket that subscribes to a stream (its seed, then a push), sends on a
// channel the handler receives, and joins an app room through a method, which
// answers with the room's presence and lets it hear a typed event.
const lineItem = {
  "~standard": {
    version: 1,
    vendor: "smoke",
    validate: (value) =>
      typeof value === "string" ? { value } : { issues: [{ message: "Expected a string" }] },
  },
};
const lounge = core.defineContract("loungeService", {
  methods: { enter: core.mutation({ input: text, output: anything }) },
  streams: { lines: { item: lineItem, scope: "room", seed: 2, access: "authenticated" } },
  channels: { wave: { payload: text } },
  events: { waved: { payload: text } },
});
const waves = [];
const loungeService = app.defineService(lounge, {
  methods: {
    enter: {
      access: "authenticated",
      handler: ({ input, ctx }) => ctx.rooms.join(input),
    },
  },
  channels: {
    wave: (payload, ctx) => {
      waves.push([ctx.principal.userId, payload]);
      ctx.rooms.emit("lobby", lounge, "waved", payload);
    },
  },
});
const realtimeApp = await testing.createTestApp({ services: [loungeService], logger: quiet });
try {
  const lines = realtimeApp.server.stream(lounge, "lines");
  lines.push("lobby", "one");
  lines.push("lobby", "two");
  lines.push("lobby", "three");
  assert.throws(() => lines.push("lobby", 4), { code: "INTERNAL" });
  const connection = await realtimeApp.connect({ userId: "smoke" });
  const { socket } = connection;
  const seen = [];
  for (const event of ["qd:stream", "qd:event", "qd:presence"]) {
    socket.on(event, (frame) => seen.push([event, frame]));
  }
  assert.deepEqual(
    await socket.timeout(5000).emitWithAck("qd:stream:sub", {
      s: "loungeService",
      stream: "lines",
      scope: "lobby",
    }),
    { ok: true, seed: ["two", "three"] },
  );
  assert.equal(await connection.call.loungeService.enter("lobby"), true);
  lines.push("lobby", "four");
  socket.emit("qd:ch", ["loungeService", "wave", "hello"]);
  await testing.emitWithAck(socket, "qd:unsub", { s: "none", ids: [] });
  assert.deepEqual(waves, [["smoke", "hello"]]);
  assert.deepEqual(seen, [
    ["qd:presence", { room: "lobby", users: ["smoke"] }],
    ["qd:stream", { s: "loungeService", stream: "lines", scope: "lobby", item: "four" }],
    ["qd:event", ["loungeService", "waved", "hello"]],
  ]);
  assert.equal(await realtimeApp.server.presence.isOnline("smoke"), true);
  assert.deepEqual(await realtimeApp.server.presence.users("lobby"), ["smoke"]);
} finally {
  await realtimeApp.close();
}
console.log(
  "ok the built server serves stream seeds and pushes, channel messages, typed events and presence",
);

// The built MCP bridge: its own entry, a contract's method as a tool, and a
// call through the stdio server over in-memory streams, through the built
// dispatcher with transport "mcp".
const mcp = await import(`${pkg.name}/server/mcp`);
assert.equal(server.createMcpRegistry, undefined, "./server must not export the MCP bridge");
for (const [source, outputs] of emittedIn) {
  if (source.startsWith("src/server/mcp/")) {
    assert.deepEqual(outputs, ["server/mcp/index.js"], `${source} must ship in ./server/mcp only`);
  }
}
const { z } = await import("zod");
const { PassThrough } = await import("node:stream");
const { createInterface } = await import("node:readline");
const greet = core.defineContract("greetService", {
  methods: {
    hello: core.query({
      input: z.object({ name: z.string() }),
      output: z.string(),
      describe: "Greets someone.",
    }),
  },
});
const greetService = app.defineService(greet, {
  methods: {
    hello: {
      access: "authenticated",
      handler: ({ input, ctx }) =>
        `hello ${input.name} from ${ctx.principal.userId} via ${ctx.transport}`,
    },
  },
});
const registry = mcp.createMcpRegistry({
  services: [greetService],
  dispatcher: server.createDispatcher({ services: [greetService], logger: quiet }),
  principal: () => ({ userId: "agent" }),
  logger: quiet,
});
assert.deepEqual(registry.tools, [
  {
    name: "greetService_hello",
    description: "Greets someone.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    annotations: { readOnlyHint: true },
  },
]);
const stdin = new PassThrough();
const stdout = new PassThrough();
const stdio = mcp.createMcpStdioServer({
  registry,
  name: "smoke",
  version: "0.0.0",
  input: stdin,
  output: stdout,
  logger: quiet,
});
const replies = [];
const replied = new Promise((resolveReplies) => {
  createInterface({ input: stdout }).on("line", (line) => {
    replies.push(JSON.parse(line));
    if (replies.length === 2) {
      resolveReplies();
    }
  });
});
for (const message of [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "greetService_hello", arguments: { name: "smoke" } },
  },
]) {
  stdin.write(`${JSON.stringify(message)}\n`);
}
await replied;
stdin.end();
await stdio.closed;
assert.equal(replies[0].result.protocolVersion, mcp.MCP_PROTOCOL_VERSION);
assert.deepEqual(replies[1], {
  jsonrpc: "2.0",
  id: 2,
  result: { content: [{ type: "text", text: '"hello smoke from agent via mcp"' }] },
});
console.log("ok the built MCP bridge lists a contract's tools and serves a call over stdio");

// The built tracked-writes adapter: its own entry, with no import of Prisma
// (the app passes its client in), and the storage lookup `./server` uses.
const prisma = await import(`${pkg.name}/prisma`);
const prismaImports = importGraph("./prisma").externals.filter(
  (imported) => !isBuiltin(imported.split(" imports ")[1]),
);
assert.deepEqual(prismaImports, [], "./prisma must import nothing but Node built-ins");
assert.throws(() => prisma.trackPrisma({}), TypeError, "trackPrisma must refuse a non-client");
assert.equal(prisma.storageOf, server.storageOf, "./prisma and ./server share storageOf");
assert.equal(prisma.storageOf({ $quickdrawStorage: {} }), undefined);
console.log(
  "ok the built ./prisma entry imports no Prisma and refuses a value that is not a client",
);

// The built client test helpers: no "use client" (checked above, with
// ./client still opening with it), Testing Library imported only when
// `renderWithQuickdraw` runs, and no jsdom and no server code anywhere in the
// entry's static import graph, so a component test that uses
// `createMockClient` alone loads neither.
const STATIC_SPECIFIER = /\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g;
const DYNAMIC_SPECIFIER = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const testingClientFiles = new Set();
const testingClientStatic = [];
const testingClientDynamic = [];
const testingClientPending = [join(packageDir, pkg.exports["./testing/client"].import)];
while (testingClientPending.length > 0) {
  const file = testingClientPending.pop();
  if (testingClientFiles.has(file)) {
    continue;
  }
  testingClientFiles.add(file);
  const code = readFileSync(file, "utf8");
  for (const match of code.matchAll(STATIC_SPECIFIER)) {
    const imported = match[1] ?? match[2];
    if (imported.startsWith("./") || imported.startsWith("../")) {
      testingClientPending.push(resolve(dirname(file), imported));
    } else {
      testingClientStatic.push(imported);
    }
  }
  for (const match of code.matchAll(DYNAMIC_SPECIFIER)) {
    testingClientDynamic.push(match[1]);
  }
}
const forbidden = testingClientStatic.filter(
  (imported) =>
    isBuiltin(imported) ||
    imported.startsWith("@testing-library/") ||
    ["jsdom", "socket.io", "express"].includes(imported),
);
assert.deepEqual(forbidden, [], "./testing/client must not statically import these");
assert.ok(
  testingClientDynamic.includes("@testing-library/react"),
  "./testing/client must import @testing-library/react lazily",
);
const serverSources = [...testingClientFiles].flatMap((file) =>
  JSON.parse(readFileSync(`${file}.map`, "utf8"))
    .sources.map((source) => relative(packageDir, resolve(dirname(file), source)))
    .filter((source) => source.startsWith("src/server/")),
);
assert.deepEqual(serverSources, [], "./testing/client must not carry server code");

// The built mock client, under plain Node: stubs answer calls, and keys are
// the real client's.
const testingClient = await import(`${pkg.name}/testing/client`);
const mock = testingClient.createMockClient({ echo });
mock.echo.say.mockResolvedValue("MOCKED");
assert.equal(await mock.echo.say.call("hi"), "MOCKED");
assert.deepEqual(mock.echo.say.calls, ["hi"]);
assert.deepEqual(mock.echo.say.key("hi"), ["qd", "echoService", "m", "say", "hi"]);
console.log(
  `ok ${pkg.name}/testing/client loads Testing Library lazily, imports no jsdom or server code, and its mock client answers from stubs`,
);

// The built auth routes kit (./server/auth): its static import graph holds
// neither express nor express-rate-limit (the default rate limiters are
// imported lazily, and that import resolves from the built output when a
// request first needs it); a mock sign-in on an Express app (start, the mock
// provider's consent, the callback), `me` with the session cookie, a v5
// socket authenticated by that cookie through the built server's
// `socketAuth`, and logout, after which neither `me` nor a new socket is let in.
/** What a built file's static import graph imports from outside the package, and imports lazily. */
function staticGraph(entryFile) {
  const files = new Set();
  const externals = [];
  const dynamic = [];
  const pending = [entryFile];
  while (pending.length > 0) {
    const file = pending.pop();
    if (files.has(file)) {
      continue;
    }
    files.add(file);
    const code = readFileSync(file, "utf8");
    for (const match of code.matchAll(STATIC_SPECIFIER)) {
      const imported = match[1] ?? match[2];
      if (imported.startsWith("./") || imported.startsWith("../")) {
        pending.push(resolve(dirname(file), imported));
      } else {
        externals.push(imported);
      }
    }
    for (const match of code.matchAll(DYNAMIC_SPECIFIER)) {
      dynamic.push(match[1].startsWith(".") ? resolve(dirname(file), match[1]) : match[1]);
    }
  }
  return { externals, dynamic };
}
const authGraph = staticGraph(join(packageDir, pkg.exports["./server/auth"].import));
assert.deepEqual(
  authGraph.externals.filter((imported) => ["express", "express-rate-limit"].includes(imported)),
  [],
  "./server/auth must not statically import express or express-rate-limit",
);
assert.ok(
  authGraph.dynamic.some(
    (file) => file.startsWith("/") && staticGraph(file).externals.includes("express-rate-limit"),
  ),
  "./server/auth must import the Express rate limiters lazily",
);

const auth = await import(`${pkg.name}/server/auth`);
const { default: createExpressApp } = await import("express");
const authSecret = "a-smoke-secret-of-at-least-thirty-two-characters";
const appOrigin = "http://app.smoke";
const authSessions = auth.createMemorySessionStore();
const authApp = createExpressApp();
const authServer = server.createServer({
  app: authApp,
  services: [echoService],
  logger: quiet,
  auth: {
    authenticate: auth.socketAuth({
      sessions: authSessions,
      jwtSecret: authSecret,
      allowedOrigins: [appOrigin],
    }),
  },
});
await new Promise((resolveListen) => {
  authServer.httpServer.listen(0, "127.0.0.1", resolveListen);
});
const authUrl = `http://127.0.0.1:${authServer.httpServer.address().port}`;
process.env.ENABLE_MOCK_OAUTH = "true";
authApp.use(
  auth.createAuthRoutes({
    providers: [
      auth.mock({
        listUsers: () => Promise.resolve([{ id: "u1", email: "smoke@demo.local", name: "Smoke" }]),
      }),
    ],
    sessions: authSessions,
    jwtSecret: authSecret,
    onLogin: (profile) => `user:${profile.email}`,
    allowedOrigins: [appOrigin],
    publicUrl: authUrl,
    logger: quiet,
  }),
);
const firstCookie = (response, name) =>
  response.headers
    .getSetCookie()
    .map((header) => header.split(";", 1)[0])
    .find((pair) => pair.startsWith(`${name}=`));
const openSocket = (cookie) => {
  const socket = connectClient(authUrl, {
    forceNew: true,
    reconnection: false,
    transports: ["websocket"],
    auth: { qd: { protocol: core.PROTOCOL_VERSION, client: "smoke" } },
    extraHeaders: { cookie, origin: appOrigin },
  });
  const outcome = new Promise((resolveOutcome) => {
    socket.once("qd:hello", (hello) => resolveOutcome({ hello }));
    socket.once("connect_error", (error) => resolveOutcome({ refused: error.data }));
  });
  return outcome.finally(() => socket.disconnect());
};
try {
  const manual = { redirect: "manual" };
  const started = await fetch(`${authUrl}/auth/mock/start?returnTo=${appOrigin}`, manual);
  assert.equal(started.status, 302);
  const authorize = new URL(started.headers.get("location"));
  authorize.searchParams.set("email", "smoke@demo.local");
  const consented = await fetch(authorize, manual);
  const callback = await fetch(consented.headers.get("location"), {
    ...manual,
    headers: { cookie: firstCookie(started, "qd_oauth") },
  });
  assert.equal(callback.headers.get("location"), `${appOrigin}/`);
  const sessionCookie = firstCookie(callback, "session");
  assert.ok(sessionCookie, "the callback must set the session cookie");
  const me = await fetch(`${authUrl}/auth/me`, { headers: { cookie: sessionCookie } });
  assert.deepEqual(await me.json(), { userId: "user:smoke@demo.local" });
  const signedIn = await openSocket(sessionCookie);
  assert.equal(signedIn.hello?.userId, "user:smoke@demo.local");

  const loggedOut = await fetch(`${authUrl}/auth/logout`, {
    method: "POST",
    headers: { cookie: sessionCookie, "content-type": "application/json" },
  });
  assert.equal(loggedOut.status, 204);
  const after = await fetch(`${authUrl}/auth/me`, { headers: { cookie: sessionCookie } });
  assert.equal(after.status, 401);
  assert.deepEqual(await openSocket(sessionCookie), { refused: { code: "UNAUTHENTICATED" } });
} finally {
  delete process.env.ENABLE_MOCK_OAUTH;
  await authServer.close();
}
console.log(
  `ok ${pkg.name}/server/auth imports express-rate-limit lazily, signs in through the mock provider, authenticates a socket by its cookie, and refuses it after logout`,
);
