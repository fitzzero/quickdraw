// The live-data tests' server: the collection tests' services
// (`../../../server/collections/__tests__/fixture.ts`) on the access tests'
// board, on PGlite with tracked writes, so writes send real `qd:e` and
// `qd:c` frames. The task service has an indexed board in pages of 10 with
// the view `mine`, an unindexed `byProject`, and `openByProject` in pages of
// 2 (at most 3). Connections are real v5 client connections, closed after
// each test.
//
//            owner   access list    members
//   P1       ada     di: Read       bo: Moderate, cy: Read
//   P2       ed      -              -
//   T1 in P1, T2 in P2

import { QueryClient } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import type { PrismaClient } from "../../../../test/prisma/setup";
import { createHarness, type Harness } from "../../../prisma/__tests__/harness";
import { seedBoard, type Board } from "../../../server/access/__tests__/board";
import {
  defineTaskService,
  labelService,
  type TaskServiceOptions,
} from "../../../server/collections/__tests__/fixture";
import { projectService, recordingStorage } from "../../../server/emit/__tests__/live";
import type { LimitsOptions, Principal, ServerAuth } from "../../../server/index";
import { createTestApp, type TestApp } from "../../../testing/index";
import { createQuickdrawConnection, type QuickdrawConnection } from "../../connection";
import { whenStatus } from "../../__tests__/fixtures";

export { taskContract } from "../../../server/collections/__tests__/fixture";
export { as } from "../../../server/access/__tests__/board";

/** Options of a live-data server. */
export interface ServerOptions extends TaskServiceOptions {
  readonly limits?: LimitsOptions;
  /** The server's `authenticate`; default: the test app's, which trusts the handshake's `principal`. */
  readonly authenticate?: NonNullable<ServerAuth["authenticate"]>;
}

/** A query client like the provider's default. */
export function freshClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false } },
  });
}

/** The live-data test harness: call once per test file. Each test gets a fresh board. */
export function liveDataHarness() {
  let h: Harness | undefined;
  let seeded: Board | undefined;
  const apps: TestApp[] = [];
  const connections: QuickdrawConnection[] = [];

  beforeAll(async () => {
    h = await createHarness();
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });
  beforeEach(async () => {
    await h?.database.reset();
    seeded = h === undefined ? undefined : await seedBoard(h.prisma);
  });
  afterEach(async () => {
    for (const connection of connections.splice(0)) {
      connection.close();
    }
    await Promise.all(apps.splice(0).map(async (app) => await app.close()));
  });

  function harness(): Harness {
    if (h === undefined) {
      throw new Error("the live-data harness has no database yet");
    }
    return h;
  }

  return {
    /** The board seeded for this test. */
    board(): Board {
      if (seeded === undefined) {
        throw new Error("the board is seeded before each test");
      }
      return seeded;
    },
    /** An untracked client on the test database, for setup and assertions. */
    prisma: (): PrismaClient => harness().prisma,
    /** Starts a server with the project, label and task services; `reads` are the reads it made. */
    async start(options: ServerOptions = {}) {
      const { storage, reads } = recordingStorage(harness().storage);
      const app = await createTestApp({
        services: [projectService, labelService, defineTaskService(options)],
        db: harness().db,
        storage,
        ...(options.limits === undefined ? {} : { limits: options.limits }),
        ...(options.authenticate === undefined
          ? {}
          : { auth: { authenticate: options.authenticate } }),
      });
      apps.push(app as unknown as TestApp);
      /** Runs `fn` on the tracked client in a unit of work, which flushes: frames go out. */
      const write = <T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> =>
        app.server.dispatcher.run(async () => await fn(harness().db));
      return { app, reads, write };
    },
    /** A connection to `url` acting as `principal`, opened and connected. */
    async connect(url: string, principal: Principal): Promise<QuickdrawConnection> {
      const connection = createQuickdrawConnection({
        url,
        auth: { principal },
        transports: ["websocket"],
      });
      connections.push(connection);
      connection.open();
      await whenStatus(connection, "connected");
      return connection;
    },
  };
}
