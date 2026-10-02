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
//   own files, with no Node built-in and no dependency;
// - `./client` opens with the "use client" directive and no other export does;
// - every source module is emitted into exactly one output file (entries share
//   chunks; with `splitting` off each entry would carry its own copy);
// - no dependency is bundled (every source path is the package's own);
// - the Redis helper's dynamic imports of its optional peers resolve from the
//   built output (both are devDependencies, so they are installed here);
// - the built JSON parser (`./parser`) writes what the stock socket.io-parser
//   encoder writes, reports the size, and refuses a binary argument;
// - the built method runtime (`./server`) defines a service from a contract,
//   runs a call through the dispatcher and its in-process caller, and answers
//   invalid input with VALIDATION.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
      "isCallEnvelope",
      "isCancel",
    ],
    client: false,
  },
  "./server": {
    symbols: [
      "initQuickdraw",
      "createDispatcher",
      "custom",
      "createBasicAccessEngine",
      "meetsLevel",
      "serviceGrant",
      "toCallReply",
      "DEFAULT_LIMITS",
      "createRateLimiter",
    ],
    client: false,
  },
  "./server/auth": { symbols: ["createJWT"], client: false },
  "./server/express": { symbols: ["createJsonRateLimiter"], client: false },
  "./client": { symbols: ["formatCurrency"], client: true },
  "./parser": { symbols: ["createJsonParser"], client: false },
  "./testing/prisma": { symbols: ["createPrismaTestGlobalSetup"], client: false },
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
  "ClientEventName",
  "ServerEventName",
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
const rootGraph = new Set();
const pending = [join(packageDir, pkg.exports["."].import)];
const externalImports = [];
while (pending.length > 0) {
  const file = pending.pop();
  if (rootGraph.has(file)) {
    continue;
  }
  rootGraph.add(file);
  for (const match of readFileSync(file, "utf8").matchAll(IMPORT_SPECIFIER)) {
    const imported = match[1] ?? match[2];
    if (imported.startsWith("./") || imported.startsWith("../")) {
      pending.push(resolve(dirname(file), imported));
    } else {
      externalImports.push(`${relative(packageDir, file)} imports ${imported}`);
    }
  }
}
assert.deepEqual(externalImports, [], "the root export must not import packages or Node built-ins");
console.log(`ok ${pkg.name} imports only its own ${rootGraph.size} files, so it runs in a browser`);

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
