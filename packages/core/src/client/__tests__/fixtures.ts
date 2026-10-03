// Shared fixtures for the client tests: a real server on a free port
// (`createTestApp`) serving the transport tests' probe service and a counter
// whose `read` query is versioned, and client connections to it. Everything
// is closed after each test.

import { afterEach, expect, vi } from "vitest";
import { z } from "zod";
import { defineContract, mutation, query, type Logger } from "../../index";
import { alice, db, deferred, qd, type AppPrincipal } from "../../server/__tests__/fixtures";
import type { CallRecord, ServerAuth } from "../../server/index";
import { isPrincipal } from "../../server/transports/auth";
import { createProbe, probe } from "../../server/transports/__tests__/probe";
import { createTestApp, type TestApp } from "../../testing/index";
import {
  createQuickdrawConnection,
  type ConnectionStatus,
  type QuickdrawConnection,
  type QuickdrawConnectionOptions,
} from "../connection";

export { alice, bob } from "../../server/__tests__/fixtures";
export { probe };

/** A counter per name: `read` is a versioned query, `bump` a mutation, `total` takes no input. */
export const counter = defineContract("counterService", {
  methods: {
    read: query({
      input: z.object({ name: z.string() }),
      output: z.object({ name: z.string(), value: z.number() }),
    }),
    bump: mutation({
      input: z.object({ name: z.string() }),
      output: z.object({ name: z.string(), value: z.number() }),
    }),
    total: query({ input: z.undefined(), output: z.number() }),
  },
});

/** The counter service, its values, and a gate that holds `read`'s version check while closed. */
export function createCounter() {
  const values = new Map<string, number>();
  let gate: Promise<void> | undefined;
  const valueOf = (name: string): number => values.get(name) ?? 0;
  const service = qd.defineService(counter, {
    methods: {
      read: {
        access: "public",
        version: async ({ name }) => {
          await gate;
          return `${name}@${valueOf(name)}`;
        },
        handler: ({ input }) => ({ name: input.name, value: valueOf(input.name) }),
      },
      bump: {
        access: "public",
        handler: ({ input }) => {
          values.set(input.name, valueOf(input.name) + 1);
          return { name: input.name, value: valueOf(input.name) };
        },
      },
      total: { access: "public", handler: () => [...values.values()].reduce((a, b) => a + b, 0) },
    },
  });
  return {
    service,
    values,
    /** Holds every `read` before its version check until the returned function runs. */
    hold(): () => void {
      const opened = deferred();
      gate = opened.promise;
      return () => {
        gate = undefined;
        opened.resolve();
      };
    },
  };
}

/** Sockets authenticate with the `principal` in their handshake; HTTP calls with `Bearer <userId>`. */
export const testAuth: ServerAuth<AppPrincipal> = {
  authenticate: ({ auth }) => {
    if (isPrincipal(auth.principal)) {
      return auth.principal as AppPrincipal;
    }
    return typeof auth.token === "string" ? { userId: auth.token, kind: "user" } : null;
  },
};

/** Resolves once `connection` is in `status`. */
export function whenStatus(
  connection: QuickdrawConnection,
  status: ConnectionStatus,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = (): boolean => {
      if (connection.getState().status !== status) {
        return false;
      }
      stop();
      clearTimeout(timer);
      resolve();
      return true;
    };
    const stop = connection.subscribe(() => {
      check();
    });
    const timer = setTimeout(() => {
      stop();
      reject(
        new Error(`still ${connection.getState().status}, not ${status}, after ${timeoutMs} ms`),
      );
    }, timeoutMs);
    check();
  });
}

/** The client test harness: call once per test file. */
export function clientHarness() {
  const apps: TestApp[] = [];
  const connections: QuickdrawConnection[] = [];

  afterEach(async () => {
    for (const connection of connections.splice(0)) {
      connection.close();
    }
    await Promise.all(apps.splice(0).map(async (app) => await app.close()));
  });

  return {
    /** Starts a server with the probe and counter services; `records` are its completed calls. */
    async start(
      options: { readonly auth?: ServerAuth<AppPrincipal>; readonly logger?: Logger } = {},
    ) {
      const probeService = createProbe();
      const counterService = createCounter();
      const records: CallRecord[] = [];
      const app = await createTestApp({
        services: [probeService.service, counterService.service],
        db,
        auth: options.auth ?? testAuth,
        onCall: (record) => records.push(record),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });
      apps.push(app as unknown as TestApp);
      return { app, probe: probeService, counter: counterService, records };
    },
    /** A connection to `url` as `principal` (handshake auth `{ principal }`), not yet opened. */
    connection(
      url: string,
      options: Partial<QuickdrawConnectionOptions> = {},
    ): QuickdrawConnection {
      const connection = createQuickdrawConnection({
        url,
        auth: { principal: alice },
        transports: ["websocket"],
        ...options,
      });
      connections.push(connection);
      return connection;
    },
    /** A connection to `url`, opened and connected. */
    async connect(
      url: string,
      options: Partial<QuickdrawConnectionOptions> = {},
    ): Promise<QuickdrawConnection> {
      const connection = this.connection(url, options);
      connection.open();
      await whenStatus(connection, "connected");
      return connection;
    },
  };
}

/** The `[event, ...args]` of every packet `connection` sends from now on. */
export function outgoing(connection: QuickdrawConnection): unknown[][] {
  const sent: unknown[][] = [];
  connection.socket.onAnyOutgoing((event: string, ...args: unknown[]) => {
    sent.push([event, ...args]);
  });
  return sent;
}

/** Waits until `predicate` holds. */
export async function until(predicate: () => boolean, timeout = 5000): Promise<void> {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout });
}
