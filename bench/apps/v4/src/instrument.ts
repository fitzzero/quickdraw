import type { Server as HttpServer } from "node:http";
import type { Socket as NetSocket } from "node:net";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Server as SocketIOServer } from "socket.io";
import type { Db } from "./db";

/**
 * Server-side measurement for the bench runner. It wraps the services from
 * the outside (handler and subscription counters) and never changes what
 * they do. Every app under bench/apps/ exposes the same numbers on
 * GET /bench/metrics, so runs of different versions compare field by field.
 */

export interface ServerMetrics {
  windowMs: number;
  cpuUserSeconds: number;
  cpuSystemSeconds: number;
  cpuSeconds: number;
  eventLoopDelayMs: { p50: number; p99: number; max: number; mean: number };
  bytesSent: number;
  bytesReceived: number;
  sqlStatements: number;
  snapshotsServed: { collection: number; collectionPages: number; entity: number };
  handlerRuns: Record<string, number>;
  inFlight: number;
  rssPeakMb: number;
  connections: number;
  listenersPerSocket: number | null;
}

interface PublicMethod {
  name: string;
  handler: (payload: never, context: never) => Promise<unknown>;
}

/** The parts of a 4.1 BaseService the instrumentation wraps. */
export interface InstrumentableService {
  serviceName: string;
  getPublicMethods(): PublicMethod[];
  subscribe(entryId: string, socket: never, level?: never): Promise<unknown>;
  batchSubscribe(
    entryIds: string[],
    socket: never,
    level?: never,
  ): Promise<Record<string, unknown>>;
  unsubscribe(entryId: string, socket: never): void;
  subscribeCollection(payload: { cursor?: string | null }, socket: never): Promise<unknown>;
  unsubscribeCollection(payload: unknown, socket: never): void;
}

const RSS_SAMPLE_MS = 250;
const NS_PER_MS = 1e6;
/**
 * The histogram samples a timer every RESOLUTION_MS and records the whole
 * interval, so an idle loop reads about 10 ms. Reported delays are the
 * lateness beyond that interval.
 */
const RESOLUTION_MS = 10;

export class Metrics {
  private readonly loop = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  private readonly liveSockets = new Set<NetSocket>();
  private closedBytesSent = 0;
  private closedBytesReceived = 0;
  private baseline = { at: 0, cpu: process.cpuUsage(), sent: 0, received: 0 };
  private sql = 0;
  private handlerRuns: Record<string, number> = {};
  private snapshots = { collection: 0, collectionPages: 0, entity: 0 };
  private inFlight = 0;
  private rssPeak = 0;
  private io: SocketIOServer | null = null;

  constructor(prisma: Db) {
    this.loop.enable();
    prisma.$on("query", () => {
      this.sql += 1;
    });
    setInterval(() => {
      this.rssPeak = Math.max(this.rssPeak, process.memoryUsage.rss());
    }, RSS_SAMPLE_MS).unref();
    this.reset();
  }

  /** Count TCP bytes on every connection the HTTP server accepts. */
  public attach(httpServer: HttpServer, io: SocketIOServer): void {
    this.io = io;
    httpServer.on("connection", (socket: NetSocket) => {
      this.liveSockets.add(socket);
      socket.on("close", () => {
        this.closedBytesSent += socket.bytesWritten;
        this.closedBytesReceived += socket.bytesRead;
        this.liveSockets.delete(socket);
      });
    });
  }

  public instrument(service: InstrumentableService): void {
    const prefix = service.serviceName;
    for (const method of service.getPublicMethods()) {
      const original = method.handler;
      const key = `${prefix}:${method.name}`;
      method.handler = async (payload, context) =>
        await this.track(key, original(payload, context));
    }
    this.wrapSubscriptions(service, prefix);
  }

  public reset(): void {
    this.loop.reset();
    this.baseline = {
      at: performance.now(),
      cpu: process.cpuUsage(),
      sent: this.totalBytes("sent"),
      received: this.totalBytes("received"),
    };
    this.sql = 0;
    this.handlerRuns = {};
    this.snapshots = { collection: 0, collectionPages: 0, entity: 0 };
    this.rssPeak = process.memoryUsage.rss();
  }

  public read(): ServerMetrics {
    const cpu = process.cpuUsage(this.baseline.cpu);
    const ms = (ns: number): number =>
      Number.isFinite(ns) ? Math.max(0, ns / NS_PER_MS - RESOLUTION_MS) : 0;
    return {
      windowMs: performance.now() - this.baseline.at,
      cpuUserSeconds: cpu.user / 1e6,
      cpuSystemSeconds: cpu.system / 1e6,
      cpuSeconds: (cpu.user + cpu.system) / 1e6,
      eventLoopDelayMs: {
        p50: ms(this.loop.percentile(50)),
        p99: ms(this.loop.percentile(99)),
        max: ms(this.loop.max),
        mean: ms(this.loop.mean),
      },
      bytesSent: this.totalBytes("sent") - this.baseline.sent,
      bytesReceived: this.totalBytes("received") - this.baseline.received,
      sqlStatements: this.sql,
      snapshotsServed: { ...this.snapshots },
      handlerRuns: { ...this.handlerRuns },
      inFlight: this.inFlight,
      rssPeakMb: Math.max(this.rssPeak, process.memoryUsage.rss()) / (1024 * 1024),
      connections: this.io?.engine.clientsCount ?? 0,
      listenersPerSocket: this.listenersPerSocket(),
    };
  }

  /** The most listeners any connected socket has (4.1 registers some per method and per service). */
  private listenersPerSocket(): number | null {
    let most: number | null = null;
    for (const socket of this.io?.of("/").sockets.values() ?? []) {
      const listeners = socket
        .eventNames()
        .reduce((sum, name) => sum + socket.listenerCount(name), 0);
      most = Math.max(most ?? 0, listeners);
    }
    return most;
  }

  private totalBytes(direction: "sent" | "received"): number {
    let total = direction === "sent" ? this.closedBytesSent : this.closedBytesReceived;
    for (const socket of this.liveSockets) {
      total += direction === "sent" ? socket.bytesWritten : socket.bytesRead;
    }
    return total;
  }

  private count(key: string): void {
    this.handlerRuns[key] = (this.handlerRuns[key] ?? 0) + 1;
  }

  private async track<T>(key: string, work: Promise<T>): Promise<T> {
    this.count(key);
    this.inFlight += 1;
    try {
      return await work;
    } finally {
      this.inFlight -= 1;
    }
  }

  private wrapSubscriptions(service: InstrumentableService, prefix: string): void {
    const subscribe = service.subscribe.bind(service);
    service.subscribe = async (entryId, socket, level) => {
      const data = await this.track(`${prefix}:subscribe`, subscribe(entryId, socket, level));
      if (data !== null) this.snapshots.entity += 1;
      return data;
    };

    const batchSubscribe = service.batchSubscribe.bind(service);
    service.batchSubscribe = async (entryIds, socket, level) => {
      const data = await this.track(
        `${prefix}:batchSubscribe`,
        batchSubscribe(entryIds, socket, level),
      );
      this.snapshots.entity += Object.values(data).filter((entry) => entry !== null).length;
      return data;
    };

    const subscribeCollection = service.subscribeCollection.bind(service);
    service.subscribeCollection = async (payload, socket) => {
      const data = await this.track(
        `${prefix}:collection:subscribe`,
        subscribeCollection(payload, socket),
      );
      if (data !== null) {
        if (payload.cursor === undefined || payload.cursor === null) {
          this.snapshots.collection += 1;
        } else {
          this.snapshots.collectionPages += 1;
        }
      }
      return data;
    };

    const unsubscribe = service.unsubscribe.bind(service);
    service.unsubscribe = (entryId, socket) => {
      this.count(`${prefix}:unsubscribe`);
      unsubscribe(entryId, socket);
    };

    const unsubscribeCollection = service.unsubscribeCollection.bind(service);
    service.unsubscribeCollection = (payload, socket) => {
      this.count(`${prefix}:collection:unsubscribe`);
      unsubscribeCollection(payload, socket);
    };
  }
}
