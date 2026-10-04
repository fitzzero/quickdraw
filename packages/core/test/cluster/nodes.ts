// A test app as a cluster of two servers (RFC 0003 section 4.4, and the
// multi-node proof of pack H): node A, which every client connects to, and
// node B, through which every in-process write goes, each behind the
// Socket.IO Redis adapter on the cluster projects' Valkey, both on the test's
// one database (PGlite runs in the test process, so the two nodes share the
// test's tracked client: two clients on one PGlite would see the same rows
// anyway). The cluster projects' setup (`setup.ts`) puts `clusterTestApp` in
// place of `createTestApp`, so every test that boots an app proves its
// assertions with the reader on one node and the writer on the other.
//
// A write through node B (`app.as(...)`, `app.server.dispatcher.run`, ...)
// resolves once the frames it sent reached node A: node B then publishes a
// barrier through the same Valkey connection, and node A's adapter hands a
// node's messages to its sockets in the order they were published. That is
// what a single server gives a test (a write resolves after its flush sent
// its frames), so assertions about what a reader did or did not receive
// stay meaningful. Work node A starts on receiving a broadcast (revoking
// after another node's access change) is not covered: tests wait for its
// frames.
//
// Each cluster has its own adapter key and counter prefix (`uniquePrefix`),
// so test files running at once on one Valkey never hear each other.

import { randomUUID } from "node:crypto";
import { createAdapter } from "@socket.io/redis-adapter";
import { lazyMembers } from "../../src/server/caller";
import type { AnyService, QuickdrawIo } from "../../src/server/index";
import type { TestApp, TestAppOptions } from "../../src/testing/createTestApp";
import { dropBarrier, registerBarrier } from "./mode";
import { closeClient, uniquePrefix, valkeyClient, type ValkeyClient } from "./valkey";

/** `createTestApp`, as the cluster helpers call it. */
export type CreateTestApp = <const S extends readonly AnyService[]>(
  options: TestAppOptions<S>,
) => Promise<TestApp<S>>;

/** One server of a test cluster, and the two Valkey connections its adapter holds. */
export interface ClusterNode<S extends readonly AnyService[] = readonly AnyService[]> {
  readonly app: TestApp<S>;
  readonly clients: readonly ValkeyClient[];
}

/** What a test cluster shares: its adapter key, which is also its counter prefix. */
export interface ClusterSettings {
  readonly prefix: string;
  /** The Valkey the nodes connect to; default the cluster projects'. */
  readonly url?: string;
}

/** The server-to-server event a write's barrier travels on. */
const BARRIER_EVENT = "qd-test:barrier";

const BARRIER_TIMEOUT_MS = 5000;

/** Boots one node: the test app's server behind the Redis adapter of the cluster. */
export async function startNode<const S extends readonly AnyService[]>(
  create: CreateTestApp,
  options: TestAppOptions<S>,
  settings: ClusterSettings,
): Promise<ClusterNode<S>> {
  const pub = valkeyClient(settings.url);
  const sub = pub.duplicate();
  sub.on("error", () => undefined);
  await Promise.all([pub.connect(), sub.connect()]);
  const app = await create({
    ...options,
    socket: { ...options.socket, adapter: createAdapter(pub, sub, { key: settings.prefix }) },
    cluster: { keyPrefix: settings.prefix, ...options.cluster },
  } as TestAppOptions<S>);
  return { app, clients: [pub, sub] };
}

/**
 * Closes the nodes' servers, then their Valkey connections: no node closes
 * its connections while another still answers it.
 */
export async function stopNodes(nodes: readonly ClusterNode[]): Promise<void> {
  await Promise.all(nodes.map(async (node) => await node.app.close()));
  await Promise.all(nodes.flatMap((node) => node.clients.map(closeClient)));
}

/**
 * Resolves once node `to` has received everything node `from` published
 * before the call: a barrier, published after it on the same connection.
 */
export function createBarrier(from: QuickdrawIo, to: QuickdrawIo): () => Promise<void> {
  const waiting = new Map<string, () => void>();
  to.on(BARRIER_EVENT, (id: unknown) => {
    if (typeof id === "string") {
      waiting.get(id)?.();
      waiting.delete(id);
    }
  });
  return () =>
    new Promise<void>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error("The cluster's barrier did not reach the reader node"));
      }, BARRIER_TIMEOUT_MS);
      waiting.set(id, () => {
        clearTimeout(timer);
        resolve();
      });
      from.serverSideEmit(BARRIER_EVENT, id);
    });
}

/** `promise`, settled only once the barrier passed, whatever it settled with. */
async function afterBarrier<T>(promise: Promise<T>, barrier: () => Promise<void>): Promise<T> {
  try {
    return await promise;
  } finally {
    await barrier();
  }
}

type Fn = (...args: unknown[]) => unknown;

/** A caller whose every call resolves once the barrier passed. */
function barrierCaller(caller: object, barrier: () => Promise<void>): object {
  const services = caller as Record<string, Record<string, Fn>>;
  return lazyMembers((service) =>
    lazyMembers<Fn>((method) => (...args) => {
      const call = services[service]?.[method];
      return afterBarrier(Promise.resolve(call?.(...args)), barrier);
    }),
  );
}

/** The writer node's dispatcher, whose writes resolve once their frames reached the reader node. */
function barrierDispatcher(
  dispatcher: TestApp["server"]["dispatcher"],
  barrier: () => Promise<void>,
): TestApp["server"]["dispatcher"] {
  return Object.freeze({
    ...dispatcher,
    call: (request: Parameters<typeof dispatcher.call>[0]) =>
      afterBarrier(dispatcher.call(request), barrier),
    caller: (principal: Parameters<typeof dispatcher.caller>[0]) =>
      barrierCaller(dispatcher.caller(principal), barrier) as ReturnType<typeof dispatcher.caller>,
    run: <T>(fn: Parameters<typeof dispatcher.run<T>>[0]) =>
      afterBarrier(dispatcher.run(fn), barrier),
  });
}

/**
 * The test app a test sees: clients connect to the reader node (`url`,
 * `connect`, `frames`, `server.io`), and in-process calls and writes go
 * through the writer node (`as`, `server.dispatcher`, `server.stream`,
 * `server.access`, `server.presence`).
 */
export function splitApp<S extends readonly AnyService[]>(
  reader: TestApp<S>,
  writer: TestApp<S>,
  barrier: () => Promise<void>,
  close: () => Promise<void>,
): TestApp<S> {
  const refresh = writer.server.access.refresh;
  const server = Object.freeze({
    ...writer.server,
    io: reader.server.io,
    httpServer: reader.server.httpServer,
    dispatcher: barrierDispatcher(writer.server.dispatcher, barrier),
    access: Object.freeze({
      ...writer.server.access,
      refresh: (userId: string) => afterBarrier(refresh(userId), barrier),
    }),
    close,
  }) as TestApp<S>["server"];
  return Object.freeze({
    url: reader.url,
    server,
    frames: reader.frames,
    as: (principal: Parameters<TestApp<S>["as"]>[0]) =>
      barrierCaller(writer.as(principal), barrier) as ReturnType<TestApp<S>["as"]>,
    connect: reader.connect,
    close,
  });
}

/** The nodes of the clusters booted, so a test can reach node B. */
const NODES = new WeakMap<object, readonly [ClusterNode, ClusterNode]>();

/** Node A (the reader) and node B (the writer) of an app `clusterTestApp` booted. */
export function nodesOf(app: object): readonly [ClusterNode, ClusterNode] {
  const nodes = NODES.get(app);
  if (nodes === undefined) {
    throw new Error("nodesOf: this app is not a test cluster");
  }
  return nodes;
}

/**
 * `createTestApp` as two nodes behind Valkey. An app the test gives its own
 * Socket.IO adapter (a test of several nodes already) boots as it asks.
 */
export async function clusterTestApp<const S extends readonly AnyService[]>(
  create: CreateTestApp,
  options: TestAppOptions<S>,
): Promise<TestApp<S>> {
  if (options.socket?.adapter !== undefined) {
    return await create(options);
  }
  const settings: ClusterSettings = { prefix: uniquePrefix() };
  // The writer boots last: `qd.run`, `qd.stream` and `qd.caller` reach the app created last.
  const reader = await startNode(create, options, settings);
  const writer = await startNode(create, options, settings).catch(async (error: unknown) => {
    await stopNodes([reader as ClusterNode]);
    throw error;
  });
  const barrier = createBarrier(writer.app.server.io, reader.app.server.io);
  registerBarrier(barrier);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= stopNodes([reader as ClusterNode, writer as ClusterNode]).then(() => {
      dropBarrier(barrier);
    }));
  const app = splitApp(reader.app, writer.app, barrier, close);
  NODES.set(app, [reader as ClusterNode, writer as ClusterNode]);
  return app;
}
