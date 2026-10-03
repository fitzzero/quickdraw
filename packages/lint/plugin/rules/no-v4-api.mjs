// Every quickdraw 4.x API that 5.0 removed or moved (RFC 0003 section 15),
// each reported with what replaces it; the 5.0 migration guide reuses these
// messages. Found by shape: imports from `@fitzzero/quickdraw-core` (removed
// names, moved names, removed entry points) and members of a namespace
// imported from it (`server.BaseService`), calls of 4.x service methods
// (`this.defineMethod(...)`, `service.emitCollectionUpsert(...)`), 4.x option
// keys (`invalidateOn`, `hasEntryACL`), `QuickdrawEventMap` augmentations and
// 4.x `QuickdrawProvider` props. A class extending an app's own `BaseService`
// is not reported: only quickdraw's, reached through an import.

import { keyName, memberName, unwrap } from "../lib/ast.mjs";

const CORE = /^@fitzzero\/quickdraw-core(?:\/.*)?$/;
const AUTH = "@fitzzero/quickdraw-core/server/auth";
const MCP = "@fitzzero/quickdraw-core/server/mcp";

const METHODS =
  "Declare methods in a contract (`defineContract(name, { methods: { name: query({ input, output }) } })`), type them with `InputOf<C, M>` and `OutputOf<C, M>`, and implement them as `{ access, handler({ input, ctx, db }) }`.";
const CHANNELS =
  "Declare channels in the contract (`channels: { name: { payload } }`), handle them in `qd.defineService(contract, { channels })`, and send with `qd.<service>.<channel>.useChannel()`.";
const EVENTS =
  "Declare room events in the contract (`events: { name: { payload } }`), send them with `ctx.rooms.emit(room, contract, event, payload)`, and listen with `qd.<service>.<event>.useEvent(handler)`.";
const ADMIN_TYPES =
  'The admin kit\'s methods are ordinary contract entries (`admin.contract({ entity })`, implemented by `admin.handlers(contract)`): type them with `InputOf<C, "adminList">` and `OutputOf<C, "adminList">`, and so on per method.';
const ENTITY_SUBSCRIBE =
  "Subscribe to rows with `qd.<service>.useEntity(id)` or `useEntities(ids)`; the client sends protocol v5's `qd:sub` itself.";
const COLLECTION_WIRE =
  "Declare collections in the contract and read them with `qd.<service>.<collection>.useCollection(scope)`; the client sends protocol v5's `qd:col:sub` itself and holds a `CollectionState`.";
const SERVICE_DEFINITION =
  "`qd.defineService(contract, definition)` returns a `Service`; its options are the `ServiceDefinition` object.";
const REGISTRY = "Pass the services to `qd.createServer({ app, services: [...], db, auth })`.";
const CREATE_SERVER =
  "Create the server with `qd.createServer({ app, services, db, auth })` (`qd = initQuickdraw<{ db, principal }>()`); it attaches to the app's own Express app and HTTP server.";
const COLLECTIONS =
  "Declare collections in the contract (`collections: { name: { scope, item, order } }`) and anchor them in `qd.defineService(contract, { collections: { name: { anchor } } })`; their deltas follow tracked writes.";
const ADMIN_FIELDS =
  "The admin kit's `adminMeta` derives the fields from the entity's JSON Schema; adjust them with `admin.handlers(contract, { fieldOverrides, hiddenFields })`.";
const MCP_TOOLS = `MCP tools are generated from the contracts: \`createMcpRegistry({ services, dispatcher })\` and \`describeTools\` from "${MCP}".`;
const USE_SERVICE =
  "Call methods through the typed client: `qd.<service>.<method>.useMutation()`, or `.useQuery(input)` for a query (`qd = createQuickdrawClient(contracts)`).";
const USE_SERVICE_QUERY =
  "Read with `qd.<service>.<method>.useQuery(input)`; a query that must follow writes declares `watch` in its contract.";
const USE_SUBSCRIPTION =
  "Subscribe to a row with `qd.<service>.useEntity(id)` (`useEntities(ids)` for several).";
const ROOM_EVENTS = "Listen to a contract event with `qd.<service>.<event>.useEvent(handler)`.";
const CHANNEL_SEND = "Send on a channel with `qd.<service>.<channel>.useChannel()`.";
const SOCKET_CONTEXT =
  "Read the connection with `useQuickdraw()` (`connection`, `status`, `userId`, `serviceAccess`), and talk to the server through the typed client rather than the socket.";
const INFERRED =
  "The typed client infers every type from the contracts passed to `createQuickdrawClient(contracts)`.";
const SOCKET_INPUTS =
  'The socket inputs were removed: keep your own input components and save with `qd.<service>.<method>.useMutation()` (a mutation with `id` and an `"entity"` output updates the cached row optimistically).';
const COLLECTION_STATE =
  "work on `CollectionState`; `liveDataOf(connection, queryClient)` holds the live collections.";
const TRACKED_DELTAS =
  "Collection deltas follow tracked writes: write through `db.<model>`, or record a write the client cannot see with `ctx.touch(model, ids)`.";
const POLICIES =
  "Row access comes from a policy on `qd.defineService(contract, { access })` (`owner`, `jsonAcl`, `members`, `inherit`, `anyOf`, `resolver`) and each method's `access` form.";
const FIELD_TIERS =
  'Field tiers are declared in the contract\'s `fields` (`fields: { notes: "Admin" }`) and stripped per caller.';

function each(names, replacement) {
  return Object.fromEntries(names.map((name) => [name, replacement]));
}

/** Names 5.0 exports from no entry point, with what replaces each. */
export const REMOVED_NAMES = Object.freeze({
  // Root (`@fitzzero/quickdraw-core`)
  ServiceResponse:
    "Handlers return their result or throw `QuickdrawError(code, message)`; the reply on the wire is `{ ok: true, d }` or `{ ok: false, e: { code, message, data? } }`, and the client throws `QuickdrawError`.",
  ...each(
    [
      "ServiceMethodMap",
      "ServiceMethodDefinition",
      "ServiceMethodContext",
      "ExtractPayload",
      "ExtractResponse",
    ],
    METHODS,
  ),
  ...each(["ServiceChannelMap", "ServiceChannelDefinition", "ServiceChannelContext"], CHANNELS),
  ...each(
    ["CHANNEL_EVENT_PREFIX", "channelEventName"],
    "Channels travel on the single `qd:ch` event, which the socket rate limiter already skips: send with `qd.<service>.<channel>.useChannel()`.",
  ),
  ...each(["QuickdrawEventMap", "QuickdrawEventName", "QuickdrawEventData"], EVENTS),
  QuickdrawUser:
    "The principal's type is the app's own, given to `initQuickdraw<{ db, principal }>()`; handlers read it as `ctx.principal`.",
  ACLEntity:
    'A row shared through a JSON access list uses the `jsonAcl(field, { owner })` policy on `qd.defineService(contract, { access })`; the sharing kit (`sharing.contract({ mode: "acl" })`) edits the list.',
  ...each(
    [
      "AdminCreatePayload",
      "AdminDeletePayload",
      "AdminDeleteResponse",
      "AdminGetPayload",
      "AdminGetSubscribersPayload",
      "AdminListPayload",
      "AdminListResponse",
      "AdminMetaPayload",
      "AdminMetaResponse",
      "AdminReemitPayload",
      "AdminReemitResponse",
      "AdminSetACLPayload",
      "AdminSubscribersResponse",
      "AdminUnsubscribeAllPayload",
      "AdminUnsubscribeAllResponse",
      "AdminUpdatePayload",
    ],
    ADMIN_TYPES,
  ),
  ...each(["SubscribePayload", "UnsubscribePayload"], ENTITY_SUBSCRIBE),
  ...each(
    [
      "CollectionSubscribePayload",
      "CollectionUnsubscribePayload",
      "CollectionSnapshotPage",
      "CollectionSnapshotResponse",
    ],
    COLLECTION_WIRE,
  ),
  ...each(
    ["serviceRoom", "serviceFullRoom"],
    "Entity rooms are per access tier (`entityRoom(service, id, level)`) and joined by `useEntity`; join an app room with `ctx.rooms.join(room)` and reach one user with `ctx.rooms.emitToUser(userId, ...)`.",
  ),
  collectionEventName:
    "Collection deltas all travel on the `qd:c` event and are applied by `qd.<service>.<collection>.useCollection(scope)`.",

  // Server (`@fitzzero/quickdraw-core/server`)
  BaseService:
    "Declare services with `qd.defineService(contract, { model, access, methods: { name: { access, handler } } })`; there are no service classes.",
  BaseRpcService:
    "A service without rows is a contract without `entity`, implemented by `qd.defineService(contract, { methods })` without `model`.",
  ...each(["BaseServiceInstance", "BaseServiceOptions"], SERVICE_DEFINITION),
  ...each(["ServiceRegistry", "ServiceRegistryInstance", "ServiceRegistryOptions"], REGISTRY),
  ...each(
    ["createQuickdrawServer", "QuickdrawServerOptions", "QuickdrawServerResult"],
    CREATE_SERVER,
  ),
  QuickdrawIdentity:
    "`qd.createServer({ auth: { authenticate } })`'s `authenticate` returns a principal, a user id string, or nothing for an anonymous caller.",
  ...each(["CollectionManager", "CollectionDefinition", "CollectionWriteEvent"], COLLECTIONS),
  InstallAdminMethodsOptions:
    "Use the admin kit: `...admin.contract({ entity })` in the contract and `...admin.handlers(contract, { displayName, hiddenFields })` in `methods`.",
  PrismaDelegate:
    "Handlers write through the tracked client, `db.<model>`, from their `{ input, ctx, db }` argument.",
  ...each(
    [
      "zodToAdminFields",
      "getDefaultEntityFields",
      "mergeWithDefaultFields",
      "ZodToAdminFieldsOptions",
    ],
    ADMIN_FIELDS,
  ),
  ...each(
    ["createMcpRoutes", "McpHttpRoutesOptions"],
    `Mount \`createMcpHttpRouter({ registry })\` from "${MCP}".`,
  ),
  ...each(
    [
      "generateToolMetadata",
      "GenerateToolMetadataOptions",
      "ServiceToolSpec",
      "MethodSpec",
      "ServiceInfo",
      "ServiceMethodInfo",
      "McpToolDefinition",
      "McpMethodDefinition",
      "McpMethodContext",
      "McpServiceInstance",
      "McpRegistryInstance",
    ],
    MCP_TOOLS,
  ),

  // Client (`@fitzzero/quickdraw-core/client`)
  ...each(["useService", "useServiceMethod", "UseServiceOptions", "UseServiceResult"], USE_SERVICE),
  ...each(
    ["useServiceQuery", "UseServiceQueryOptions", "UseServiceQueryResult"],
    USE_SERVICE_QUERY,
  ),
  ...each(["useSubscription", "UseSubscriptionOptions", "UseSubscriptionResult"], USE_SUBSCRIPTION),
  useCollection:
    "Collections are members of the typed client: `qd.<service>.<collection>.useCollection(scope, { view, load })`.",
  ...each(["useRoomEvents", "UseRoomEventsOptions", "QuickdrawRoomEventHandlers"], ROOM_EVENTS),
  ...each(["useChannelSend", "UseChannelSendResult"], CHANNEL_SEND),
  ...each(["useQuickdrawSocket", "QuickdrawSocketContextValue"], SOCKET_CONTEXT),
  ServiceCallError:
    "Failed calls throw `QuickdrawError`: branch on `error.code` (`FORBIDDEN`, `NOT_FOUND`, `VALIDATION`, `CONFLICT`, ...).",
  ...each(["ClientServiceMethodMap", "SubscriptionDataMap"], INFERRED),
  applySnapshot: `Renamed \`applyCollectionSnapshot\`; the collection helpers ${COLLECTION_STATE}`,
  applyPage: `Renamed \`applyCollectionPage\`; the collection helpers ${COLLECTION_STATE}`,
  ...each(
    ["applyDelta", "applyDeltas"],
    `Use \`applyCollectionDeltas\`, which applies a batch; the collection helpers ${COLLECTION_STATE}`,
  ),
  createEmptyEntry: `Use \`emptyCollection()\`; the collection helpers ${COLLECTION_STATE}`,
  CollectionCacheEntry: `The collection state is \`CollectionState\`; the collection helpers ${COLLECTION_STATE}`,
  ...each(
    [
      "SocketTextField",
      "SocketTextFieldProps",
      "SocketCheckbox",
      "SocketCheckboxProps",
      "SocketSelect",
      "SocketSelectProps",
      "SocketSlider",
      "SocketSliderProps",
      "SocketSwitch",
      "SocketSwitchProps",
      "useSocketInput",
      "UseSocketInputOptions",
      "UseSocketInputResult",
      "CommitMode",
    ],
    SOCKET_INPUTS,
  ),
});

/** Names 5.0 moved off an entry point: entry → name → replacement. */
export const MOVED_NAMES = Object.freeze({
  "@fitzzero/quickdraw-core/server": {
    ...each(
      [
        "AuthRequest",
        "AuthResponse",
        "CookieResponse",
        "CookieSettings",
        "DEFAULT_MOCK_PATH_PREFIX",
        "DiscordUser",
        "GoogleUser",
        "JWTPayload",
        "MockOAuthProviderOptions",
        "MockOAuthRouter",
        "MockOAuthUser",
        "OAUTH_RETURN_ORIGIN_COOKIE",
        "OAuthConfig",
        "OAuthProvider",
        "OAuthTokenResponse",
        "RegisterMockOAuthOptions",
        "RequireAuthOptions",
        "SESSION_COOKIE",
        "SessionCookieOptions",
        "ValidateOriginOptions",
        "clearSessionCookie",
        "createJWT",
        "createMockOAuthProvider",
        "createOAuthURL",
        "createRequireAuth",
        "discordProvider",
        "exchangeOAuthCode",
        "extractBearerOrCookieToken",
        "getDiscordAvatarUrl",
        "googleProvider",
        "isMockOAuthEnabled",
        "registerMockOAuthProvider",
        "setSessionCookie",
        "validateRedirectOrigin",
        "verifyJWT",
      ],
      `Moved: import it from "${AUTH}".`,
    ),
    ...each(
      ["bootstrapMcpServer", "createMcpStdioServer", "McpStdioServerOptions", "McpRegistryOptions"],
      `Moved: import it from "${MCP}".`,
    ),
    McpRegistry: `Moved to "${MCP}", where the registry is created with \`createMcpRegistry({ services, dispatcher })\` (\`McpRegistry\` is now its type, not a class).`,
    QuickdrawSocket:
      "The server's socket type is gone: handlers receive `ctx` (`ctx.principal`, `ctx.rooms`, `ctx.transport`) instead of the socket.",
  },
});

/** Entry points 5.0 removed, with what replaces each. */
export const REMOVED_ENTRIES = Object.freeze({
  "@fitzzero/quickdraw-core/server/testing":
    'Use `createTestApp({ services, db })` from "@fitzzero/quickdraw-core/testing" (`app.as(principal)` calls in process, `app.connect(principal)` opens a real socket); `emitWithAck` and `waitForEvent` moved there too.',
  "@fitzzero/quickdraw-core/server/testing/prisma":
    'Moved to "@fitzzero/quickdraw-core/testing/prisma", with the same functions.',
  "@fitzzero/quickdraw-core/client/testing":
    'Use `createMockClient(contracts)` or `renderWithQuickdraw(ui, { app, as })` from "@fitzzero/quickdraw-core/testing/client".',
  "@fitzzero/quickdraw-core/eslint-plugin":
    'The lint rules moved to the oxlint plugin "@fitzzero/quickdraw-lint", which its `oxlint.base.jsonc` loads.',
  "@fitzzero/quickdraw-core/eslint-config":
    'Extend "@fitzzero/quickdraw-lint/oxlint.base.jsonc" from the app\'s oxlint config instead.',
});

/** 4.x service methods (called on a service instance), with what replaces each. */
export const REMOVED_MEMBERS = Object.freeze({
  defineMethod:
    "Implement methods in `qd.defineService(contract, { methods: { name: { access, handler } } })`.",
  verifyAllMethods:
    "`qd.defineService` checks at compile time that `methods` implements every method of the contract.",
  emitUpdate:
    "Entity frames follow tracked writes: write through `db.<model>`, or record a write the client cannot see with `ctx.touch(model, ids)`.",
  ...each(
    ["emitCollectionUpsert", "emitCollectionRemove", "emitCollectionMove", "notifyCollections"],
    TRACKED_DELTAS,
  ),
  emitCollectionReset:
    "Send one scope a reset with `qd.collections.reset(contract, collection, scope)`.",
  kickFromCollection:
    "Revocation is automatic: a tracked write that lowers someone's access removes their sockets from the scope and sends `qd:revoked`.",
  emitToRoom:
    "Declare the event in the contract's `events` and send it with `ctx.rooms.emit(room, contract, event, payload)`.",
  emitToUserRoom: "Send to one user with `ctx.rooms.emitToUser(userId, contract, event, payload)`.",
  emitToRoomVolatile:
    "Declare a stream with `volatile: true` in the contract's `streams` and push with `qd.stream(contract, name).push(...)`.",
  defineCollection: COLLECTIONS,
  defineChannel: CHANNELS,
  installAdminMethods:
    "Use the admin kit: `...admin.contract({ entity })` in the contract and `...admin.handlers(contract, options)` in `methods`.",
  setDelegate:
    'Name the service\'s model in `qd.defineService(contract, { model: "chat" })`; handlers write through `db.<model>`.',
  ...each(["checkEntryACL", "checkBatchSubscriptionAccess", "ensureAccessForMethod"], POLICIES),
  ...each(["getProtectedFields", "hasElevatedAccess"], FIELD_TIERS),
});

/** 4.x option keys, with what replaces each. */
export const REMOVED_OPTIONS = Object.freeze({
  invalidateOn:
    "Give the query a `watch` in its contract (`query({ input, output, watch: { collection, scope } })`): it is refetched when that scope changes.",
  hasEntryACL:
    'Declare the row policy in `qd.defineService(contract, { access: jsonAcl("acl", { owner: "ownerId" }) })`.',
});

/** 4.x `QuickdrawProvider` props, with what replaces each. */
export const REMOVED_PROVIDER_PROPS = Object.freeze({
  serverUrl:
    "Pass `url`, and the typed client as `client`: `<QuickdrawProvider client={qd} url={url} auth={token}>`.",
  authToken: "Pass the credentials as `auth`: a token string or handshake fields.",
  autoConnect:
    "The provider connects when it mounts; render it once the credentials are known, or change `auth`.",
  withCredentials:
    "Pass Socket.IO options in `socketOptions`: `socketOptions={{ withCredentials: true }}`.",
  socketPath: "Pass Socket.IO options in `socketOptions`: `socketOptions={{ path }}`.",
  reconnectBehavior:
    "Removed: after a reconnect only watched or stale queries refetch, spread over 0 to 2 s.",
});

function importedName(specifier) {
  return specifier.imported.type === "Identifier"
    ? specifier.imported.name
    : specifier.imported.value;
}

function exportedLocal(specifier) {
  return specifier.local.type === "Identifier" ? specifier.local.name : specifier.local.value;
}

function elementName(node) {
  if (node.type === "JSXIdentifier") {
    return node.name;
  }
  return node.type === "JSXMemberExpression" ? node.property.name : undefined;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow quickdraw 4.x APIs that 5.0 removed; each message names the replacement.",
    },
    messages: {
      removedName: "`{{ name }}` is a quickdraw 4.x API removed in 5.0. {{ replacement }}",
      movedName:
        '`{{ name }}` is not exported from "{{ source }}" in quickdraw 5.0. {{ replacement }}',
      removedEntry: '"{{ source }}" was removed in quickdraw 5.0. {{ replacement }}',
      removedMember:
        "`.{{ name }}()` is a quickdraw 4.x service method removed in 5.0. {{ replacement }}",
      removedOption: "`{{ name }}` is a quickdraw 4.x option removed in 5.0. {{ replacement }}",
      removedProp: "`{{ name }}` is a quickdraw 4.x prop of `QuickdrawProvider`. {{ replacement }}",
      eventMap: `Augmenting \`QuickdrawEventMap\` is how 4.x typed room events. ${EVENTS}`,
    },
    schema: [],
  },
  create(context) {
    const namespaces = new Set();

    const checkImport = (node) => {
      const source = node.source.value;
      if (typeof source !== "string" || !CORE.test(source)) {
        return;
      }
      if (Object.hasOwn(REMOVED_ENTRIES, source)) {
        context.report({
          node: node.source,
          messageId: "removedEntry",
          data: { source, replacement: REMOVED_ENTRIES[source] },
        });
        return;
      }
      const moved = MOVED_NAMES[source] ?? {};
      for (const specifier of node.specifiers ?? []) {
        if (specifier.type === "ImportNamespaceSpecifier") {
          namespaces.add(specifier.local.name);
          continue;
        }
        if (specifier.type !== "ImportSpecifier" && specifier.type !== "ExportSpecifier") {
          continue;
        }
        const name =
          specifier.type === "ImportSpecifier" ? importedName(specifier) : exportedLocal(specifier);
        if (Object.hasOwn(REMOVED_NAMES, name)) {
          context.report({
            node: specifier,
            messageId: "removedName",
            data: { name, replacement: REMOVED_NAMES[name] },
          });
        } else if (Object.hasOwn(moved, name)) {
          context.report({
            node: specifier,
            messageId: "movedName",
            data: { name, source, replacement: moved[name] },
          });
        }
      }
    };

    return {
      ImportDeclaration: checkImport,
      ExportNamedDeclaration(node) {
        if (node.source !== null) {
          checkImport(node);
        }
      },
      ExportAllDeclaration(node) {
        const source = node.source.value;
        if (Object.hasOwn(REMOVED_ENTRIES, source)) {
          context.report({
            node: node.source,
            messageId: "removedEntry",
            data: { source, replacement: REMOVED_ENTRIES[source] },
          });
        }
      },
      ImportExpression(node) {
        const source = node.source.type === "Literal" ? node.source.value : undefined;
        if (typeof source === "string" && Object.hasOwn(REMOVED_ENTRIES, source)) {
          context.report({
            node: node.source,
            messageId: "removedEntry",
            data: { source, replacement: REMOVED_ENTRIES[source] },
          });
        }
      },
      CallExpression(node) {
        const callee = unwrap(node.callee);
        const name = callee.type === "MemberExpression" ? memberName(callee) : undefined;
        if (name !== undefined && Object.hasOwn(REMOVED_MEMBERS, name)) {
          context.report({
            node: callee.property,
            messageId: "removedMember",
            data: { name, replacement: REMOVED_MEMBERS[name] },
          });
        }
      },
      Property(node) {
        const name = keyName(node);
        if (
          name !== undefined &&
          Object.hasOwn(REMOVED_OPTIONS, name) &&
          node.parent?.type === "ObjectExpression"
        ) {
          context.report({
            node: node.key,
            messageId: "removedOption",
            data: { name, replacement: REMOVED_OPTIONS[name] },
          });
        }
      },
      MemberExpression(node) {
        const object = unwrap(node.object);
        const name = memberName(node);
        if (
          object.type === "Identifier" &&
          namespaces.has(object.name) &&
          Object.hasOwn(REMOVED_NAMES, name)
        ) {
          context.report({
            node,
            messageId: "removedName",
            data: { name, replacement: REMOVED_NAMES[name] },
          });
        }
      },
      TSInterfaceDeclaration(node) {
        if (node.id.name !== "QuickdrawEventMap") {
          return;
        }
        const module = context.sourceCode
          .getAncestors(node)
          .find((ancestor) => ancestor.type === "TSModuleDeclaration");
        if (module?.id.type === "Literal" && CORE.test(module.id.value)) {
          context.report({ node: node.id, messageId: "eventMap" });
        }
      },
      JSXOpeningElement(node) {
        if (elementName(node.name) !== "QuickdrawProvider") {
          return;
        }
        for (const attribute of node.attributes) {
          const name = attribute.type === "JSXAttribute" ? attribute.name.name : undefined;
          if (typeof name === "string" && Object.hasOwn(REMOVED_PROVIDER_PROPS, name)) {
            context.report({
              node: attribute,
              messageId: "removedProp",
              data: { name, replacement: REMOVED_PROVIDER_PROPS[name] },
            });
          }
        }
      },
    };
  },
};
