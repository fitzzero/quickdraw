import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sleep } from "../time";
import { runOrThrow } from "./exec";
import { cpusAllowed, sameCpus } from "./machine";

/**
 * One app under bench/apps/<name>. The contract every app keeps:
 * `src/seed.ts <workload.json>` resets the database to the workload,
 * `src/server.ts` serves Socket.IO plus GET /health and the /bench/* routes,
 * and `prisma/schema.sql` creates its tables. Both entry points read
 * DATABASE_URL; the server also reads PORT and JWT_SECRET.
 */

export interface AppInfo {
  app: string;
  pid: number;
  node: string;
  versions: Record<string, string>;
  dbPoolMax: number;
  logging: string;
}

const JWT_SECRET = "quickdraw-bench-secret";
const HEALTH_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 15_000;

export async function generateClient(appDir: string): Promise<void> {
  await runOrThrow("bun", ["run", "generate"], {
    cwd: appDir,
    env: { PRISMA_HIDE_UPDATE_MESSAGE: "1" },
  });
}

export async function seed(
  appDir: string,
  databaseUrl: string,
  workloadPath: string,
): Promise<void> {
  await runOrThrow("node", ["--import", "tsx", "src/seed.ts", workloadPath], {
    cwd: appDir,
    env: { DATABASE_URL: databaseUrl },
  });
}

export interface ServerOptions {
  appDir: string;
  port: number;
  cpus: string;
  databaseUrl: string;
  logFile: string;
  /** Write a V8 CPU profile of the server to this directory under this file name. */
  profile?: { dir: string; name: string };
}

/** Exits the profiled server on SIGTERM, so Node writes its profile (`exit-on-signal.mjs`). */
const EXIT_ON_SIGNAL = fileURLToPath(new URL("./exit-on-signal.mjs", import.meta.url));

/** Node's arguments for the server: the profiler's when profiling, then tsx and the entry point. */
function serverArgs(profile: ServerOptions["profile"]): string[] {
  const profiling =
    profile === undefined
      ? []
      : [
          "--cpu-prof",
          "--cpu-prof-dir",
          profile.dir,
          "--cpu-prof-name",
          profile.name,
          "--import",
          EXIT_ON_SIGNAL,
        ];
  return [...profiling, "--import", "tsx", "src/server.ts"];
}

export class AppServer {
  private exitCode: number | null = null;
  private exited = false;

  private constructor(
    private readonly child: ChildProcess,
    private readonly base: string,
    readonly logFile: string,
  ) {
    child.on("exit", (code, signal) => {
      this.exited = true;
      this.exitCode = code ?? (signal ? 128 : 1);
    });
  }

  /** Start the server pinned to `cpus` with taskset, and wait for /health. */
  public static async start(options: ServerOptions): Promise<AppServer> {
    const log = openSync(options.logFile, "a");
    const child = spawn("taskset", ["-c", options.cpus, "node", ...serverArgs(options.profile)], {
      cwd: options.appDir,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(options.port),
        DATABASE_URL: options.databaseUrl,
        JWT_SECRET,
      },
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    const server = new AppServer(child, `http://127.0.0.1:${options.port}`, options.logFile);
    await server.waitForHealth();
    const allowed = cpusAllowed(child.pid ?? 0);
    if (allowed === null || !sameCpus(allowed, options.cpus)) {
      await server.stop();
      throw new Error(`server pinned to "${allowed ?? "unknown"}", expected "${options.cpus}"`);
    }
    return server;
  }

  public get pid(): number {
    return this.child.pid ?? 0;
  }

  public get url(): string {
    return this.base;
  }

  /** Null while running; the exit code once the process has gone. */
  public get exitStatus(): number | null {
    return this.exited ? this.exitCode : null;
  }

  public async info(): Promise<AppInfo> {
    return (await this.get("/bench/info")) as AppInfo;
  }

  public async tokens(): Promise<Record<string, string>> {
    return (await this.get("/bench/tokens")) as Record<string, string>;
  }

  public async resetMetrics(): Promise<void> {
    await this.fetchJson("/bench/metrics/reset", "POST", 30_000);
  }

  public async readMetrics(timeoutMs = 60_000): Promise<unknown> {
    return await this.fetchJson("/bench/metrics", "GET", timeoutMs);
  }

  public async stop(): Promise<void> {
    if (this.exited) return;
    this.child.kill("SIGTERM");
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (!this.exited && Date.now() < deadline) await sleep(100);
    if (!this.exited) {
      this.child.kill("SIGKILL");
      while (!this.exited) await sleep(50);
    }
  }

  /** The end of the server log, for error messages. */
  public logTail(lines = 20): string {
    try {
      return readFileSync(this.logFile, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
    } catch {
      return "";
    }
  }

  private async get(path: string): Promise<unknown> {
    return await this.fetchJson(path, "GET", 30_000);
  }

  private async fetchJson(path: string, method: string, timeoutMs: number): Promise<unknown> {
    const response = await fetch(`${this.base}${path}`, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}`);
    return (await response.json()) as unknown;
  }

  private async waitForHealth(): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.exited) {
        throw new Error(`server exited with ${this.exitCode} during startup:\n${this.logTail()}`);
      }
      const healthy = await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(1_000) })
        .then((response) => response.ok)
        .catch(() => false);
      if (healthy) return;
      await sleep(200);
    }
    await this.stop();
    throw new Error(`server not healthy within ${HEALTH_TIMEOUT_MS} ms:\n${this.logTail()}`);
  }
}
