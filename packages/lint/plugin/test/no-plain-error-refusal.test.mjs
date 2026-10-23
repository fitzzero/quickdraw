import { run } from "./tester.mjs";

/** The server's entry, where the template creates its server. */
const SERVER = "apps/api/src/server.ts";

/** Where the template serves its services as MCP tools. */
const MCP = "apps/api/src/mcp.ts";

run("no-plain-error-refusal", {
  valid: [
    {
      name: "refusals made with QuickdrawError, anonymous callers let in with null, and socketAuth",
      filename: SERVER,
      code: `
        export const server = qd.createServer({
          app,
          services,
          db,
          auth: {
            authenticate: async ({ auth }) => {
              if (typeof auth.token !== "string") return null;
              const session = await sessions.get(auth.token);
              if (session === null) throw new QuickdrawError("UNAUTHENTICATED", "No session");
              return { userId: session.userId, kind: "user" };
            },
          },
        });
        export const other = createServer({
          app,
          services,
          db,
          auth: {
            authenticate: socketAuth({
              sessions,
              jwtSecret,
              allowedOrigins,
              loadPrincipal: async (userId) => {
                const user = await db.user.findUnique({ where: { id: userId } });
                if (user === null) return null;
                return { userId, kind: user.kind };
              },
            }),
          },
        });
      `,
    },
    {
      name: "a throw caught in the function, one in a catch clause (a failure passed on), and one in a nested function",
      filename: SERVER,
      code: `
        createServer({
          app,
          auth: {
            authenticate: async ({ auth }) => {
              const parse = (token) => {
                if (token.length > 512) throw new Error("too long");
                return token;
              };
              try {
                if (typeof auth.token !== "string") throw new Error("no token");
                return await verify(parse(auth.token));
              } catch (error) {
                if (error instanceof QuickdrawError) throw error;
                throw new Error("The session store failed", { cause: error });
              }
            },
          },
        });
      `,
    },
    {
      name: "the app's own error class, an authenticate from another module, and the other auth hooks",
      filename: SERVER,
      code: `
        import { authenticate } from "./auth/authenticate";
        createServer({ app, auth: { authenticate } });
        createHttpRouter({
          dispatcher,
          auth: {
            authenticate: ({ auth }) => {
              if (auth.token === undefined) throw new SessionError("expired");
              return null;
            },
            loadServiceAccess: () => {
              throw new Error("grants are not stored yet");
            },
          },
        });
      `,
    },
    {
      name: "Node's own createServer, and a call that names no authenticate",
      filename: SERVER,
      code: `
        import { createServer as createHttpServer } from "node:http";
        export const plain = http.createServer((req, res) => {
          throw new Error("unreachable");
        });
        export const secure = https.createServer({ key, cert }, app);
        export const quiet = createServer({ app, services, db });
        export const devOnly = socketAuth({ sessions, jwtSecret, allowedOrigins, devCredentials: (userId) => { throw new Error(userId); } });
      `,
    },
    {
      name: "a test that makes authenticate fail on purpose",
      filename: "apps/api/src/__tests__/server.test.ts",
      code: `
        const app = qd.createServer({ app: express(), auth: { authenticate: () => { throw new Error("down"); } } });
      `,
    },
    {
      name: "an MCP principal hook refusing with QuickdrawError, one from another module, and the registry's other hooks",
      filename: MCP,
      code: `
        import { verifyAgent } from "./auth/agents";
        export const registry = createMcpRegistry({
          services,
          dispatcher: server.dispatcher,
          principal: async (request) => {
            if (request.transport !== "http" || request.token === null) return null;
            const agent = await agents.find(request.token);
            if (agent === null) throw new QuickdrawError("UNAUTHENTICATED", "Unknown agent token");
            return { userId: agent.userId, kind: "agent" };
          },
          context: () => {
            throw new Error("scopes are not stored yet");
          },
          bind: { projectId: () => { throw new Error("no project"); } },
        });
        export const imported = createMcpRegistry({ services, dispatcher, principal: verifyAgent });
      `,
    },
    {
      name: "an MCP principal hook's throws that are caught, nested, or of the app's own error class",
      filename: MCP,
      code: `
        createMcpRegistry({
          services,
          dispatcher,
          principal: async (request) => {
            const parse = (token) => {
              if (token.length > 512) throw new Error("too long");
              return token;
            };
            try {
              return await verifyAgent(parse(request.token));
            } catch (error) {
              if (error instanceof QuickdrawError) throw error;
              throw new Error("The token store failed", { cause: error });
            }
          },
        });
        createMcpRegistry({ services, dispatcher, principal: () => { throw new AgentTokenError("expired"); } });
      `,
    },
    {
      name: "a test that makes an MCP principal hook fail on purpose",
      filename: "apps/api/src/__tests__/mcp.test.ts",
      code: `
        const registry = createMcpRegistry({ services, dispatcher, principal: () => { throw new Error("down"); } });
      `,
    },
  ],
  invalid: [
    {
      name: "plain errors thrown by an authenticate written in qd.createServer, with and without new",
      filename: SERVER,
      code: `
        export const server = qd.createServer({
          app,
          services,
          db,
          auth: {
            authenticate: async ({ auth }) => {
              if (typeof auth.token !== "string") throw new Error("No token");
              const session = await sessions.get(auth.token);
              if (session === null) throw TypeError("No session");
              return { userId: session.userId, kind: "user" };
            },
          },
        });
      `,
      errors: [
        {
          message:
            "`authenticate` throws a plain error here, which quickdraw takes for the server's own failure (its session store down, say): " +
            "a socket's handshake is refused `INTERNAL` and the client keeps the user and connects again, for ever if the credentials are bad, and an HTTP call is answered `INTERNAL`. " +
            'To refuse the credentials, `throw new QuickdrawError("UNAUTHENTICATED", ...)`, which signs the client out; to let the caller in anonymously, return `null`.',
        },
        { messageId: "authenticate" },
      ],
    },
    {
      name: "a method of the auth object, and a function of this file the auth names, in a try without catch",
      filename: SERVER,
      code: `
        async function authenticate(request) {
          const lock = await sessions.lock();
          try {
            if (await sessions.revoked(request.auth.token)) throw new Error("Revoked");
            return sessions.principal(request.auth.token);
          } finally {
            lock.release();
          }
        }
        createServer({ app, auth: { authenticate } });
        createHttpRouter({
          dispatcher,
          auth: {
            authenticate({ auth }) {
              if (!auth.token) throw new RangeError("No token");
              return verify(auth.token);
            },
          },
        });
      `,
      errors: [{ messageId: "authenticate" }, { messageId: "authenticate" }],
    },
    {
      name: "an auth object and an authenticate held by consts, given to two calls, reported once",
      filename: SERVER,
      code: `
        const authenticate = ({ auth }) => {
          try {
            return verify(auth.token);
          } catch {
            return null;
          } finally {
            if (auth.strict) throw new Error("Strict");
          }
        };
        const auth = { authenticate };
        export const server = createServer({ app, auth });
        export const router = createHttpRouter({ dispatcher, auth });
      `,
      errors: [{ messageId: "authenticate" }],
    },
    {
      name: "socketAuth's loadPrincipal written in place",
      filename: SERVER,
      code: `
        export const server = qd.createServer({
          app,
          auth: {
            authenticate: socketAuth({
              sessions,
              jwtSecret,
              allowedOrigins,
              loadPrincipal: async (userId) => {
                const user = await db.user.findUnique({ where: { id: userId } });
                if (user === null) throw new Error("No such user");
                return { userId, kind: user.kind };
              },
            }),
          },
        });
      `,
      errors: [
        {
          message:
            "`loadPrincipal` throws a plain error here, which `socketAuth` passes on as the server's own failure: " +
            "a socket's handshake is refused `INTERNAL` and the client keeps the user and connects again, for ever if the session's user is gone, and an HTTP call is answered `INTERNAL`. " +
            'To refuse the session\'s user, return `null` (or `throw new QuickdrawError("UNAUTHENTICATED", ...)`), which signs the client out.',
        },
      ],
    },
    {
      name: "an MCP principal hook written in createMcpRegistry",
      filename: MCP,
      code: `
        export const registry = createMcpRegistry({
          services,
          dispatcher: server.dispatcher,
          principal: async (request) => {
            if (request.transport !== "http" || request.token === null) return null;
            const agent = await agents.find(request.token);
            if (agent === null) throw new Error("Unknown agent token");
            return { userId: agent.userId, kind: "agent" };
          },
        });
      `,
      errors: [
        {
          message:
            "The MCP registry's `principal` hook throws a plain error here, which the registry takes for the server's own failure (its token store down, say): " +
            "the call is answered `INTERNAL` (500 over HTTP), so the agent is never told its token is refused, and may keep sending it. " +
            'To refuse the token, `throw new QuickdrawError("UNAUTHENTICATED", ...)`; to let the caller in anonymously, return `null`.',
        },
      ],
    },
    {
      name: "a principal hook declared in this file and given through an options const to a namespace's createMcpRegistry, and a method",
      filename: MCP,
      code: `
        import * as mcp from "@fitzzero/quickdraw-core/server/mcp";
        function principal(request) {
          if (request.transport === "http" && request.token === null) throw new TypeError("No token");
          return verifyAgent(request.token);
        }
        const options = { services, dispatcher, principal };
        export const registry = mcp.createMcpRegistry(options);
        export const readers = createMcpRegistry({
          services,
          dispatcher,
          principal(request) {
            if (!request.token) throw Error("No token");
            return verifyAgent(request.token);
          },
        });
      `,
      errors: [{ messageId: "principal" }, { messageId: "principal" }],
    },
  ],
});
