import {
  MOVED_NAMES,
  REMOVED_ENTRIES,
  REMOVED_MEMBERS,
  REMOVED_NAMES,
  REMOVED_OPTIONS,
  REMOVED_PROVIDER_PROPS,
} from "../rules/no-v4-api.mjs";
import { COMPONENT, SERVICE, run } from "./tester.mjs";

const CLIENT = "@fitzzero/quickdraw-core/client";
const SERVER = "@fitzzero/quickdraw-core/server";

// The names the plan lists, each with the replacement its message must name.
const NAMED = [
  [
    "BaseService",
    `import { BaseService } from "${SERVER}";`,
    /qd\.defineService\(contract, \{ model, access, methods/,
  ],
  ["BaseRpcService", `import { BaseRpcService } from "${SERVER}";`, /a contract without `entity`/],
  [
    "ServiceRegistry",
    `import { ServiceRegistry } from "${SERVER}";`,
    /qd\.createServer\(\{ app, services/,
  ],
  [
    "useService",
    `import { useService } from "${CLIENT}";`,
    /qd\.<service>\.<method>\.useMutation\(\)/,
  ],
  ["useServiceMethod", `import { useServiceMethod } from "${CLIENT}";`, /\.useMutation\(\)/],
  [
    "useServiceQuery",
    `import { useServiceQuery } from "${CLIENT}";`,
    /qd\.<service>\.<method>\.useQuery\(input\)/,
  ],
  [
    "useSubscription",
    `import { useSubscription } from "${CLIENT}";`,
    /qd\.<service>\.useEntity\(id\)/,
  ],
  [
    "useRoomEvents",
    `import { useRoomEvents } from "${CLIENT}";`,
    /qd\.<service>\.<event>\.useEvent\(handler\)/,
  ],
  [
    "useChannelSend",
    `import { useChannelSend } from "${CLIENT}";`,
    /qd\.<service>\.<channel>\.useChannel\(\)/,
  ],
  [
    "defineMethod",
    `this.defineMethod("rename", "Moderate", handler);`,
    /methods: \{ name: \{ access, handler \} \}/,
  ],
  ["verifyAllMethods", `this.verifyAllMethods(["rename"]);`, /checks at compile time/],
  ["emitUpdate", `this.emitUpdate(id, patch);`, /Entity frames follow tracked writes/],
  [
    "emitCollectionUpsert",
    `service.emitCollectionUpsert("byProject", row);`,
    /Collection deltas follow tracked writes/,
  ],
  [
    "emitCollectionReset",
    `this.emitCollectionReset("byProject", projectId);`,
    /qd\.collections\.reset\(contract, collection, scope\)/,
  ],
  ["notifyCollections", `await this.notifyCollections(before, after);`, /ctx\.touch\(model, ids\)/],
  [
    "kickFromCollection",
    `await this.kickFromCollection("byProject", projectId, userId);`,
    /Revocation is automatic/,
  ],
  [
    "installAdminMethods",
    `this.installAdminMethods({ schema });`,
    /admin\.handlers\(contract, options\)/,
  ],
  [
    "emitToRoom",
    `this.emitToRoom(room, "chat:typing", payload);`,
    /ctx\.rooms\.emit\(room, contract, event, payload\)/,
  ],
  [
    "invalidateOn",
    `useServiceQuery2("taskService", "search", input, { invalidateOn: ["task:updated"] });`,
    /`watch` in its contract/,
  ],
];

/** One invalid case per name of every table, asserting that name's whole message. */
function tableCases() {
  const cases = [];
  for (const [name, replacement] of Object.entries(REMOVED_NAMES)) {
    cases.push({
      name: `removed: ${name}`,
      filename: SERVICE,
      code: `import { ${name} } from "${CLIENT}";`,
      errors: [{ message: `\`${name}\` is a quickdraw 4.x API removed in 5.0. ${replacement}` }],
    });
  }
  for (const [source, names] of Object.entries(MOVED_NAMES)) {
    for (const [name, replacement] of Object.entries(names)) {
      cases.push({
        name: `moved: ${name}`,
        filename: SERVICE,
        code: `import { ${name} } from "${source}";`,
        errors: [
          {
            message: `\`${name}\` is not exported from "${source}" in quickdraw 5.0. ${replacement}`,
          },
        ],
      });
    }
  }
  for (const [source, replacement] of Object.entries(REMOVED_ENTRIES)) {
    cases.push({
      name: `removed entry: ${source}`,
      filename: SERVICE,
      code: `import { anything } from "${source}";`,
      errors: [{ message: `"${source}" was removed in quickdraw 5.0. ${replacement}` }],
    });
  }
  for (const [name, replacement] of Object.entries(REMOVED_MEMBERS)) {
    cases.push({
      name: `removed method: ${name}`,
      filename: SERVICE,
      code: `this.${name}(a, b);`,
      errors: [
        {
          message: `\`.${name}()\` is a quickdraw 4.x service method removed in 5.0. ${replacement}`,
        },
      ],
    });
  }
  for (const [name, replacement] of Object.entries(REMOVED_OPTIONS)) {
    cases.push({
      name: `removed option: ${name}`,
      filename: SERVICE,
      code: `const options = { ${name}: value };`,
      errors: [{ message: `\`${name}\` is a quickdraw 4.x option removed in 5.0. ${replacement}` }],
    });
  }
  for (const [name, replacement] of Object.entries(REMOVED_PROVIDER_PROPS)) {
    cases.push({
      name: `removed prop: ${name}`,
      filename: COMPONENT,
      code: `const app = <QuickdrawProvider ${name}={value}>{children}</QuickdrawProvider>;`,
      errors: [
        { message: `\`${name}\` is a quickdraw 4.x prop of \`QuickdrawProvider\`. ${replacement}` },
      ],
    });
  }
  return cases;
}

run("no-v4-api", {
  valid: [
    {
      name: "5.0 imports from every entry point",
      filename: SERVICE,
      code: `
        import { AccessLevel, collectionRoom, crud, defineContract, mutation, query, userRoom } from "@fitzzero/quickdraw-core";
        import { admin, inherit, initQuickdraw, setupRedisAdapter } from "@fitzzero/quickdraw-core/server";
        import { createAuthRoutes, createJWT, verifyJWT } from "@fitzzero/quickdraw-core/server/auth";
        import { createMcpRegistry, createMcpStdioServer } from "@fitzzero/quickdraw-core/server/mcp";
        import { createTestApp, emitWithAck } from "@fitzzero/quickdraw-core/testing";
        import { resetDatabase } from "@fitzzero/quickdraw-core/testing/prisma";
        import { trackPrisma } from "@fitzzero/quickdraw-core/prisma";
      `,
    },
    {
      name: "the 5.0 client: the provider's new props and member hooks named like 4.x ones",
      filename: COMPONENT,
      code: `
        import { QuickdrawProvider, createQuickdrawClient, useQuickdraw } from "@fitzzero/quickdraw-core/client";
        const qd = createQuickdrawClient({ task });
        export function App({ token, children }) {
          const { items } = qd.task.byProject.useCollection(projectId);
          return <QuickdrawProvider client={qd} url={API_URL} auth={token} socketOptions={{ withCredentials: true }}>{children}</QuickdrawProvider>;
        }
      `,
    },
    {
      name: "an app's own names that 4.x also used",
      filename: SERVICE,
      code: `
        class BaseService {}
        class TaskStore extends BaseService {}
        function defineCollection(name) { return { name }; }
        const invalidateOn = ["x"];
        interface QuickdrawEventMap { tick: number }
        export const watchers = { watch: { collection: "board", scope: (input) => input.projectId } };
        defineCollection("board");
      `,
    },
  ],
  invalid: [
    ...NAMED.map(([name, code, replacement]) => ({
      name: `the plan's list: ${name}`,
      filename: SERVICE,
      code,
      errors: [{ message: replacement }],
    })),
    {
      name: "a class extending quickdraw's BaseService through a namespace import, and a re-export",
      filename: SERVICE,
      code: `
        import * as server from "@fitzzero/quickdraw-core/server";
        export class ChatService extends server.BaseService {}
        export { useSubscription as useRow } from "@fitzzero/quickdraw-core/client";
      `,
      errors: [
        {
          messageId: "removedName",
          data: { name: "BaseService", replacement: REMOVED_NAMES.BaseService },
        },
        {
          messageId: "removedName",
          data: { name: "useSubscription", replacement: REMOVED_NAMES.useSubscription },
        },
      ],
    },
    {
      name: "augmenting QuickdrawEventMap",
      filename: SERVICE,
      code: `
        declare module "@fitzzero/quickdraw-core" {
          interface QuickdrawEventMap {
            "chat:typing": { userName: string };
          }
        }
      `,
      errors: [{ messageId: "eventMap" }],
    },
    {
      name: "a 4.x provider",
      filename: COMPONENT,
      code: `const app = <QuickdrawProvider serverUrl="http://localhost:4000" authToken={getAuthToken()}>{children}</QuickdrawProvider>;`,
      errors: [
        {
          messageId: "removedProp",
          data: { name: "serverUrl", replacement: REMOVED_PROVIDER_PROPS.serverUrl },
        },
        {
          messageId: "removedProp",
          data: { name: "authToken", replacement: REMOVED_PROVIDER_PROPS.authToken },
        },
      ],
    },
    {
      name: "a removed entry point, imported dynamically and re-exported",
      filename: SERVICE,
      code: `
        export * from "@fitzzero/quickdraw-core/client/testing";
        const testing = await import("@fitzzero/quickdraw-core/server/testing");
      `,
      errors: [
        {
          messageId: "removedEntry",
          data: {
            source: "@fitzzero/quickdraw-core/client/testing",
            replacement: REMOVED_ENTRIES["@fitzzero/quickdraw-core/client/testing"],
          },
        },
        {
          messageId: "removedEntry",
          data: {
            source: "@fitzzero/quickdraw-core/server/testing",
            replacement: REMOVED_ENTRIES["@fitzzero/quickdraw-core/server/testing"],
          },
        },
      ],
    },
    ...tableCases(),
  ],
});
