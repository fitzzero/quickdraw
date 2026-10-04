import type { Server as HttpServer } from "node:http";
import type { Socket as NetSocket } from "node:net";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { CallRecord, QuickdrawIo } from "@fitzzero/quickdraw-core/server";
import type { Db } from "./db";

/**
 * Server-side measurement for the bench runner, the same numbers as
 * bench/apps/v4/src/instrument.ts on GET /bench/metrics, so runs of the two
 * versions compare field by field. It never changes what the app does: it
 * reads the completion record every call produces (`onCall`), counts the
 * Prisma client's query events, and watches each socket's incoming frames
 * through a Socket.IO middleware registered after the framework's own.
 *
 * - Handler runs per method: completion records of calls that ran their
 *   own handler. A call that joined another's shared run (`share: "all"`)
 *   reports no statements of its own (`sqlStatements` is undefined), so
 *   only the call that started the run counts it.
 * - Subscription work: every `qd:sub`, `qd:col:sub`, `qd:col:items`,
 *   `qd:watch` and unsubscribe frame, per service.
 * - Snapshots served: collection pages answered to `qd:col:sub` (a resume
 *   is not a snapshot) and the rows `qd:sub` sent (not "not modified").
 * - In flight: calls whose completion record has not been emitted yet (it
 *   comes after the call's flush, so a flush still sending frames counts),
 *   plus subscription frames not acknowledged yet.
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
  snapshotsServed: {
    collection: number;
    collectionPages: number;
    entity: number;
    collectionResumes: number;
    entityNotModified: number;
  };
  handlerRuns: Record<string, number>;
  inFlight: number;
  rssPeakMb: number;
  connections: number;
  listenersPerSocket: number | null;
}

const RSS_SAMPLE_MS = 250;
const NS_PER_MS = 1e6;
/**
 * The histogram samples a timer every RESOLUTION_MS and records the whole
 * interval, so an idle loop reads about 10 ms. Reported delays are the
 * lateness beyond that interval.
 */
const RESOLUTION_MS = 10;

const CALL_EVENT = "qd:call";
/** Subscription frames: the ones with an acknowledgement are in flight until it is sent. */
const SUBSCRIPTION_EVENTS = new Set([
  "qd:sub",
  "qd:unsub",
  "qd:col:sub",
  "qd:col:unsub",
  "qd:col:items",
  "qd:watch",
  "qd:unwatch",
]);

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function emptySnapshots(): ServerMetrics["snapshotsServed"] {
  return {
    collection: 0,
    collectionPages: 0,
    entity: 0,
    collectionResumes: 0,
    entityNotModified: 0,
  };
}

export class Metrics {
  private readonly loop = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  private readonly liveSockets = new Set<NetSocket>();
  private closedBytesSent = 0;
  private closedBytesReceived = 0;
  private baseline = { at: 0, cpu: process.cpuUsage(), sent: 0, received: 0 };
  private sql = 0;
  private handlerRuns: Record<string, number> = {};
  private snapshots = emptySnapshots();
  private callsArrived = 0;
  private callsCompleted = 0;
  private subscriptionsInFlight = 0;
  private rssPeak = 0;
  private io: QuickdrawIo | null = null;

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

  /** Count TCP bytes on every connection, and watch every socket's incoming frames. */
  public attach(httpServer: HttpServer, io: QuickdrawIo): void {
    this.io = io;
    httpServer.on("connection", (socket: NetSocket) => {
      this.liveSockets.add(socket);
      socket.on("close", () => {
        this.closedBytesSent += socket.bytesWritten;
        this.closedBytesReceived += socket.bytesRead;
        this.liveSockets.delete(socket);
      });
    });
    io.on("connection", (socket) => {
      // Acknowledgements a dropped socket will never send. Watched on the
      // engine connection, so the socket keeps the listeners it would have.
      const unanswered = new Set<() => void>();
      socket.conn.once("close", () => {
        for (const settle of [...unanswered]) settle();
      });
      socket.use((packet, next) => {
        this.observe(packet, unanswered);
        next();
      });
    });
  }

  /** The dispatcher's `onCall`: one completion record per call, after its flush. */
  public readonly onCall = (record: CallRecord): void => {
    if (record.transport === "socket") {
      this.callsCompleted += 1;
    }
    if (record.sqlStatements !== undefined) {
      this.count(`${record.service}:${record.method}`);
    }
  };

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
    this.snapshots = emptySnapshots();
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
      inFlight: this.callsArrived - this.callsCompleted + this.subscriptionsInFlight,
      rssPeakMb: Math.max(this.rssPeak, process.memoryUsage.rss()) / (1024 * 1024),
      connections: this.io?.engine.clientsCount ?? 0,
      listenersPerSocket: this.listenersPerSocket(),
    };
  }

  /** The most listeners any connected socket has: the same few however many methods the services have. */
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

  private observe(packet: unknown[], unanswered: Set<() => void>): void {
    const [event, frame] = packet;
    if (event === CALL_EVENT) {
      this.callsArrived += 1;
      return;
    }
    if (typeof event !== "string" || !SUBSCRIPTION_EVENTS.has(event)) {
      return;
    }
    const service = field(frame, "s");
    this.count(`${typeof service === "string" ? service : "?"}:${event}`);
    const last = packet.length - 1;
    const ack = packet[last];
    if (last < 1 || typeof ack !== "function") {
      return;
    }
    this.subscriptionsInFlight += 1;
    let open = true;
    const settle = (): void => {
      if (open) {
        open = false;
        unanswered.delete(settle);
        this.subscriptionsInFlight -= 1;
      }
    };
    unanswered.add(settle);
    packet[last] = (reply: unknown): unknown => {
      // Socket.IO's ack may be called again with a fallback when a reply cannot be encoded.
      const sent: unknown = (ack as (reply: unknown) => unknown)(reply);
      if (open) {
        settle();
        this.countSnapshots(event, frame, reply);
      }
      return sent;
    };
  }

  private countSnapshots(event: string, frame: unknown, reply: unknown): void {
    if (field(reply, "ok") !== true) {
      return;
    }
    if (event === "qd:col:sub") {
      if (field(reply, "resumed") === true) {
        this.snapshots.collectionResumes += 1;
      } else if (field(frame, "cursor") === undefined) {
        this.snapshots.collection += 1;
      } else {
        this.snapshots.collectionPages += 1;
      }
      return;
    }
    if (event === "qd:sub") {
      const results = field(reply, "r");
      for (const result of Array.isArray(results) ? results : []) {
        if (field(result, "ok") !== true) {
          continue;
        }
        if (field(result, "nm") === true) {
          this.snapshots.entityNotModified += 1;
        } else {
          this.snapshots.entity += 1;
        }
      }
    }
  }
}
