// `createTestApp` (RFC 0003 section 13): the app's real server on a free
// port, with an `authenticate` that trusts the principal a test connects as,
// and a recorder of every frame the server sends (`frames.ts`). Its
// dispatcher becomes the current one of the `initQuickdraw` instance that
// defined the services, so `qd.stream`, `qd.presence` and `qd.run` reach
// it. It replaces 4.1's `createTestServer` and `connectAsUser`
// (`legacy-src/server/testing.ts:62-130`), which took a fixed port counter
// and authenticated by a bare user id.

import type { AddressInfo } from "node:net";
import { consoleLogger, type Logger } from "../contract/logger";
import type { HelloFrame } from "../protocol/version";
import type { Caller } from "../server/caller";
import { createServer, type QuickdrawServer, type ServerOptions } from "../server/createServer";
import type { ContractOfServices, PrincipalOfServices } from "../server/dispatcher";
import { runtimeOf, type AnyService } from "../server/service";
import { isPrincipal } from "../server/transports/auth";
import { recordFrames, type FrameRecorder } from "./frames";
import { connectV5, socketCaller, type ClientSocket } from "./socket";

/**
 * Makes `dispatcher` the current one of every `initQuickdraw` instance that
 * defined one of `services`, as that instance's own `createServer` would:
 * `qd.stream(...).push`, `qd.presence`, `qd.run` and `qd.caller` then go
 * through the test app. The last app created wins.
 */
function adoptDispatcher(services: readonly AnyService[], dispatcher: object): void {
  const runtimes = new Set(services.map((service) => runtimeOf(service)));
  for (const runtime of runtimes) {
    runtime?.adopt?.(dispatcher);
  }
}

/**
 * Options of {@link createTestApp}: the server's. Without `auth.authenticate`
 * a socket acts as the `principal` it connects with; the rate limiter is off
 * unless `rateLimit` is given; the logger prints warnings and errors only.
 */
export type TestAppOptions<S extends readonly AnyService[]> = ServerOptions<S>;

/** A socket connected to the test app. */
export interface TestConnection<S extends readonly AnyService[] = readonly AnyService[]> {
  /** The raw Socket.IO client socket, for frames `call` does not cover. */
  readonly socket: ClientSocket;
  /** The server's `qd:hello`. */
  readonly hello: HelloFrame;
  /**
   * Calls methods over this socket, typed like `as(principal)`:
   * `call.taskService.get(input)` resolves with the data or rejects with the
   * call's `QuickdrawError`. Aborting `options.signal` sends `qd:cancel`.
   */
  readonly call: Caller<ContractOfServices<S>>;
  /** Disconnects the socket. */
  close(): void;
}

/** The running test app. */
export interface TestApp<S extends readonly AnyService[] = readonly AnyService[]> {
  /** The server's URL, `http://127.0.0.1:{port}`. */
  readonly url: string;
  readonly server: QuickdrawServer<S>;
  /**
   * Every frame the server sent any socket since the app started (or since
   * `frames.clear()`), with the socket, its user and the time:
   * `app.frames({ event: "qd:e", userId })`, `app.frames.waitFor(match)`.
   */
  readonly frames: FrameRecorder;
  /** A typed in-process caller acting as `principal` (`null` for anonymous). */
  as(principal: PrincipalOfServices<S> | null): Caller<ContractOfServices<S>>;
  /**
   * Connects a real v5 socket acting as `principal` (`null` for anonymous);
   * resolves once the server said hello, rejects when it refused the socket.
   */
  connect(principal: PrincipalOfServices<S> | null): Promise<TestConnection<S>>;
  /** Disconnects every socket `connect` opened, then closes the server. */
  close(): Promise<void>;
}

const TIMEOUT_MS = 5000;

const quietLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message, meta) => consoleLogger.warn(message, meta),
  error: (message, meta) => consoleLogger.error(message, meta),
  child: () => quietLogger,
};

/**
 * Boots the app's services on `createServer`, listening on a free port of
 * 127.0.0.1, for tests that call them in process or over real sockets.
 *
 * @example
 * const app = await createTestApp({ services: [taskService], db: testPrisma });
 * await app.as(alice).taskService.rename({ id, title });
 * const { call } = await app.connect(alice);
 * await call.taskService.get({ id });
 * await app.frames.waitFor({ event: "qd:e", userId: alice.userId });
 * await app.close();
 */
export async function createTestApp<const S extends readonly AnyService[]>(
  options: TestAppOptions<S>,
): Promise<TestApp<S>> {
  type P = PrincipalOfServices<S>;
  // The spread keeps `services` and `db` as given; TypeScript cannot see that
  // through the conditional `db` member of the options.
  const server = createServer<S>({
    ...options,
    logger: options.logger ?? quietLogger,
    rateLimit: options.rateLimit ?? false,
    auth: {
      authenticate: ({ auth }) => (isPrincipal(auth.principal) ? (auth.principal as P) : null),
      ...options.auth,
    },
  } as ServerOptions<S>);
  adoptDispatcher(options.services, server.dispatcher);
  const frames = recordFrames(server.io);
  await new Promise<void>((resolve) => {
    server.httpServer.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.httpServer.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const sockets = new Set<ClientSocket>();

  return {
    url,
    server,
    frames,
    as: (principal) => server.dispatcher.caller(principal),
    async connect(principal) {
      const { socket, hello } = await connectV5(
        url,
        principal === null ? {} : { principal },
        TIMEOUT_MS,
      );
      sockets.add(socket);
      return {
        socket,
        hello,
        call: socketCaller(socket, TIMEOUT_MS) as Caller<ContractOfServices<S>>,
        close: () => {
          sockets.delete(socket);
          socket.disconnect();
        },
      };
    },
    async close() {
      for (const socket of sockets) {
        socket.disconnect();
      }
      sockets.clear();
      await server.close();
    },
  };
}
