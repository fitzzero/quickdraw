import { io, type Socket } from "socket.io-client";
import type { Outcome, Recorder } from "../../recorder";

/**
 * One client connection speaking the 4.1 wire protocol: `<service>:<method>`
 * events acknowledged with `{ success, data | error }`, exactly as the 4.1
 * React hooks emit them.
 */

export interface DriverContext {
  url: string;
  recorder: Recorder;
}

interface Envelope {
  success: boolean;
  data?: unknown;
  error?: string;
}

/** How long a connection attempt may take before the client gives up on it. */
const CONNECT_TIMEOUT_MS = 30_000;

export class V4Connection {
  public readonly socket: Socket;
  private readonly inFlight = new Set<(outcome: Outcome) => void>();

  constructor(
    private readonly ctx: DriverContext,
    token: string,
  ) {
    // forceNew: one real connection per simulated client (socket.io-client
    // would otherwise multiplex every client onto one connection). The
    // transports match QuickdrawProvider's default.
    this.socket = io(ctx.url, {
      auth: { token },
      transports: ["websocket", "polling"],
      forceNew: true,
      autoConnect: false,
    });
    // An ack for a request in flight can never arrive once the connection is
    // gone; settle those requests as abandoned instead of waiting them out.
    this.socket.on("disconnect", () => {
      for (const settle of [...this.inFlight]) settle({ ok: false, reason: "abandoned" });
    });
  }

  public get connected(): boolean {
    return this.socket.connected;
  }

  public async connect(): Promise<void> {
    if (this.socket.connected) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`no connection within ${CONNECT_TIMEOUT_MS} ms`));
      }, CONNECT_TIMEOUT_MS);
      const onConnect = (): void => {
        cleanup();
        resolve();
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        this.socket.off("connect", onConnect);
      };
      this.socket.on("connect", onConnect);
      this.socket.connect();
    });
  }

  /** Emit with an ack. `timeoutMs: null` means the 4.1 client sets no timeout for this call. */
  public async request(
    event: string,
    payload: unknown,
    timeoutMs: number | null,
  ): Promise<Outcome> {
    return await new Promise<Outcome>((resolve) => {
      const tracked = this.ctx.recorder.begin(event);
      const startedAt = performance.now();
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = (outcome: Outcome): void => {
        if (!this.inFlight.delete(settle)) return;
        if (timer) clearTimeout(timer);
        tracked.finish(outcome, performance.now() - startedAt);
        resolve(outcome);
      };
      this.inFlight.add(settle);
      if (timeoutMs !== null) {
        timer = setTimeout(() => settle({ ok: false, reason: "timeout" }), timeoutMs);
      }
      this.socket.emit(event, payload, (response: Envelope) => {
        if (!this.inFlight.has(settle)) {
          tracked.late();
          return;
        }
        settle(
          response.success
            ? { ok: true, data: response.data }
            : { ok: false, reason: "error", error: response.error ?? "unknown error" },
        );
      });
    });
  }

  public close(): void {
    this.socket.disconnect();
  }
}
